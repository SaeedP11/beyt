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
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use anyhow::{Result, anyhow};
use gtk::{glib, prelude::*};
pub use libmpv2::Mpv;
use libmpv2::render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType};
use serde::Serialize;
use tauri::WebviewWindow;

use crate::audio::AudioTrack;

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

/// Opens `path` with `audio` files as extra audio tracks. mpv picks the
/// audio track itself; the page switches to the series' choice once the
/// tracks are known.
pub fn load(mpv: &Mpv, path: &str, audio: &[String]) -> Result<()> {
    let set = || -> libmpv2::Result<()> {
        // A track chosen for the last file would carry over to this one.
        mpv.set_property("aid", "auto")?;
        mpv.command("change-list", &["audio-files", "clr", ""])?;
        for file in audio {
            // `-append` takes one path as is, even with `:` in it.
            mpv.command("change-list", &["audio-files", "append", file])?;
        }
        Ok(())
    };
    set().map_err(|e| anyhow!("setting up audio files: {e:?}"))?;
    mpv.command("loadfile", &[path, "replace"])
        .map_err(|e| anyhow!("loading {path}: {e:?}"))
}

// ---------- audio tracks ----------

/// The open file's audio tracks, raw; `audio::finish` tidies them.
pub fn audio_tracks(mpv: &Mpv) -> Vec<AudioTrack> {
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    (0..count)
        .filter_map(|i| {
            let get = |field: &str| mpv.get_property::<String>(&format!("track-list/{i}/{field}")).ok();
            let flag = |field: &str| mpv.get_property::<bool>(&format!("track-list/{i}/{field}")).unwrap_or(false);
            if get("type").as_deref() != Some("audio") {
                return None;
            }
            Some(AudioTrack {
                id: mpv.get_property(&format!("track-list/{i}/id")).ok()?,
                lang: get("lang").unwrap_or_default(),
                detail: get("title").unwrap_or_default(),
                codec: get("codec"),
                channels: mpv.get_property(&format!("track-list/{i}/demux-channel-count")).ok(),
                default: flag("default"),
                selected: flag("selected"),
                supported: true,
                file: flag("external").then(|| get("external-filename")).flatten(),
                added: false,
            })
        })
        .collect()
}

/// Changes whenever the audio tracks of `video` do (one is added, removed or
/// selected). None while mpv is still on another file.
pub fn audio_signature(mpv: &Mpv, video: &str) -> Option<String> {
    let path = mpv.get_property::<String>("path").ok()?;
    if path != video {
        return None;
    }
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    let aid = mpv.get_property::<String>("aid").unwrap_or_default();
    Some(format!("{count}:{aid}"))
}

pub fn select_audio(mpv: &Mpv, id: i64) -> Result<()> {
    mpv.set_property("aid", id).map_err(|e| anyhow!("switching audio tracks: {e:?}"))
}

/// Adds an audio file to the open video and switches to it.
pub fn add_audio(mpv: &Mpv, path: &str) -> Result<()> {
    mpv.command("audio-add", &[path, "select"])
        .map_err(|_| anyhow!("This file has no audio Beyt can play."))
}

pub fn remove_audio(mpv: &Mpv, id: i64) -> Result<()> {
    let playing = audio_tracks(mpv).iter().any(|t| t.id == id && t.selected);
    mpv.command("audio-remove", &[&id.to_string()])
        .map_err(|e| anyhow!("removing the audio track: {e:?}"))?;
    // Removing the playing track leaves mpv silent rather than picking another.
    let rest = audio_tracks(mpv);
    match rest.iter().find(|t| t.default).or(rest.first()) {
        Some(next) if playing => select_audio(mpv, next.id),
        _ => Ok(()),
    }
}

/// Shapes the picture: `auto` (see `fit_auto`), `original`, a ratio such as
/// `16:9` (checked by the `set_aspect` command), `fill` (zoom in until the
/// bars are gone) or `stretch`.
pub fn set_aspect(mpv: &Mpv, aspect: &str) -> Result<()> {
    let (ratio, panscan, keep) = match aspect {
        "auto" | "original" => ("no", 0.0, true),
        "fill" => ("no", 1.0, true),
        "stretch" => ("no", 0.0, false),
        ratio => (ratio, 0.0, true),
    };
    let set = || -> libmpv2::Result<()> {
        mpv.set_property("video-aspect-override", ratio)?;
        mpv.set_property("panscan", panscan)?;
        mpv.set_property("keepaspect", keep)
    };
    set().map_err(|e| anyhow!("setting the aspect ratio: {e:?}"))?;
    AUTO_ASPECT.store(aspect == "auto", Ordering::Relaxed);
    fit_auto(mpv);
    Ok(())
}

/// The `auto` shape is in use.
static AUTO_ASPECT: AtomicBool = AtomicBool::new(false);
/// The video area's size in pixels as last drawn, width in the high half.
static AREA_SIZE: AtomicU64 = AtomicU64::new(0);

/// The most of the picture `auto` cuts off to get rid of the black bars.
const AUTO_MAX_CROP: f64 = 0.11;

/// For the `auto` shape: fills the area when that crops little of the
/// picture (a 16:9 video on a 16:10 screen) and shows it whole otherwise
/// (a 4:3 or 2.39:1 video on a wide screen). Runs on every clock tick, so
/// it follows window resizes and newly loaded videos.
pub fn fit_auto(mpv: &Mpv) {
    if !AUTO_ASPECT.load(Ordering::Relaxed) {
        return;
    }
    let size = AREA_SIZE.load(Ordering::Relaxed);
    let (w, h) = ((size >> 32) as f64, (size & 0xffff_ffff) as f64);
    let Ok(video) = mpv.get_property::<f64>("video-params/aspect") else { return };
    if w == 0.0 || h == 0.0 || video <= 0.0 {
        return;
    }
    let area = w / h;
    let crop = 1.0 - area.min(video) / area.max(video);
    let panscan = if crop <= AUTO_MAX_CROP { 1.0 } else { 0.0 };
    if mpv.get_property::<f64>("panscan").ok() != Some(panscan) {
        let _ = mpv.set_property("panscan", panscan);
    }
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
            AREA_SIZE.store(((w as u64) << 32) | h as u64, Ordering::Relaxed);
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
