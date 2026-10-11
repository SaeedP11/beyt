//! mpv playback and its video surface.
//!
//! mpv renders through its OpenGL render API into a `GtkGLArea`. The area sits
//! under Tauri's webview in a `GtkOverlay`, and the webview's transparent page
//! draws the subtitles and controls on top. This keeps everything inside one
//! Wayland surface tree, so no window positioning is needed.

use std::{
    cell::RefCell,
    ffi::{CString, c_char, c_void},
    rc::Rc,
    sync::OnceLock,
};

use anyhow::{Result, anyhow};
use gtk::{glib, prelude::*};
use libmpv2::{
    Mpv,
    render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType},
};
use serde::Serialize;
use tauri::WebviewWindow;

/// Creates the mpv instance. It lives for the whole process, which lets the
/// render context borrow it from GTK callbacks.
pub fn create_mpv() -> Result<&'static Mpv> {
    let mpv = Mpv::with_initializer(|init| {
        init.set_property("vo", "libmpv")?;
        init.set_property("hwdec", "auto-safe")?;
        init.set_property("keep-open", "yes")?;
        // Text subtitles are drawn by the overlay, not by mpv.
        init.set_property("sid", "no")?;
        init.set_property("input-default-bindings", "no")?;
        init.set_property("msg-level", "all=warn")?;
        Ok(())
    })
    .map_err(|e| anyhow!("starting mpv: {e:?}"))?;
    Ok(Box::leak(Box::new(mpv)))
}

pub fn load(mpv: &Mpv, path: &str) -> Result<()> {
    mpv.command("loadfile", &[path, "replace"])
        .map_err(|e| anyhow!("loading {path}: {e:?}"))
}

/// Puts a GL area for mpv's video under the window's webview.
pub fn attach_video(window: &WebviewWindow, mpv: &'static Mpv) -> Result<()> {
    let vbox = window.default_vbox()?;
    let overlay = gtk::Overlay::new();
    let area = gtk::GLArea::new();
    area.set_auto_render(false);
    area.set_has_alpha(false);
    area.set_hexpand(true);
    area.set_vexpand(true);

    let render: Rc<RefCell<Option<RenderContext<'static>>>> = Rc::default();

    area.connect_realize({
        let render = render.clone();
        move |area| {
            area.make_current();
            if let Some(err) = area.error() {
                eprintln!("beyt: no OpenGL context for video: {err}");
                return;
            }
            let ctx = mpv.create_render_context(vec![
                RenderParam::ApiType(RenderParamApiType::OpenGl),
                RenderParam::InitParams(OpenGLInitParams { get_proc_address, ctx: () }),
            ]);
            let mut ctx = match ctx {
                Ok(ctx) => ctx,
                Err(err) => {
                    eprintln!("beyt: mpv render context failed: {err:?}");
                    return;
                }
            };
            // mpv calls this from its own thread when a new frame is ready.
            let weak: glib::SendWeakRef<gtk::GLArea> = area.downgrade().into();
            ctx.set_update_callback(move || {
                let weak = weak.clone();
                glib::idle_add_once(move || {
                    if let Some(area) = weak.upgrade() {
                        area.queue_render();
                    }
                });
            });
            *render.borrow_mut() = Some(ctx);
        }
    });

    area.connect_unrealize({
        let render = render.clone();
        move |area| {
            area.make_current();
            render.borrow_mut().take();
        }
    });

    area.connect_resize(|area, _, _| area.queue_render());

    area.connect_render(move |area, _| {
        if let Some(ctx) = render.borrow().as_ref() {
            let scale = area.scale_factor();
            let (w, h) = (area.allocated_width() * scale, area.allocated_height() * scale);
            if let Err(err) = ctx.render::<()>(current_framebuffer(), w, h, true) {
                eprintln!("beyt: mpv render failed: {err:?}");
            }
        }
        glib::Propagation::Stop
    });

    // Move the webview from the window's box into the overlay, above the video.
    // This must come after the signal handlers: the window is already showing,
    // so `show_all` realizes the area immediately.
    for child in vbox.children() {
        vbox.remove(&child);
        overlay.add_overlay(&child);
    }
    overlay.add(&area);
    vbox.pack_start(&overlay, true, true, 0);
    overlay.show_all();

    Ok(())
}

// ---------- OpenGL function loading ----------

type GetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;

struct GlLoader {
    get: GetProcAddress,
    _lib: libloading::Library,
}

/// GTK uses EGL on Wayland and GLX on X11; load from whichever is in use.
fn loader() -> &'static GlLoader {
    static LOADER: OnceLock<GlLoader> = OnceLock::new();
    LOADER.get_or_init(|| {
        let wayland = gtk::gdk::Display::default()
            .is_some_and(|d| d.type_().name().contains("Wayland"));
        let (lib, sym): (&str, &[u8]) = if wayland {
            ("libEGL.so.1", b"eglGetProcAddress\0")
        } else {
            ("libGL.so.1", b"glXGetProcAddressARB\0")
        };
        unsafe {
            let lib = libloading::Library::new(lib).unwrap_or_else(|e| panic!("loading {lib}: {e}"));
            let get = *lib
                .get::<GetProcAddress>(sym)
                .unwrap_or_else(|e| panic!("finding GL loader: {e}"));
            GlLoader { get, _lib: lib }
        }
    })
}

fn get_proc_address(_ctx: &(), name: &str) -> *mut c_void {
    let name = CString::new(name).expect("GL function name");
    unsafe { (loader().get)(name.as_ptr()) }
}

/// The framebuffer GtkGLArea bound for this frame; mpv must draw into it.
fn current_framebuffer() -> i32 {
    type GetIntegerv = unsafe extern "C" fn(u32, *mut i32);
    const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
    static GET_INTEGERV: OnceLock<usize> = OnceLock::new();
    let f = *GET_INTEGERV.get_or_init(|| get_proc_address(&(), "glGetIntegerv") as usize);
    let mut fbo = 0;
    unsafe {
        let f: GetIntegerv = std::mem::transmute(f);
        f(GL_FRAMEBUFFER_BINDING, &mut fbo);
    }
    fbo
}

// ---------- playback state for the overlay ----------

/// The `playback` event payload. The overlay extrapolates between events,
/// so these only have to correct drift.
#[derive(Clone, Serialize)]
pub struct Playback {
    pub time: f64,
    pub paused: bool,
    pub speed: f64,
    pub duration: f64,
    /// At the end of the file (playback stops there because of `keep-open`).
    pub eof: bool,
}

pub fn playback(mpv: &Mpv) -> Playback {
    Playback {
        time: mpv.get_property("time-pos").unwrap_or(0.0),
        paused: mpv.get_property("pause").unwrap_or(true),
        speed: mpv.get_property("speed").unwrap_or(1.0),
        duration: mpv.get_property("duration").unwrap_or(0.0),
        eof: mpv.get_property("eof-reached").unwrap_or(false),
    }
}
