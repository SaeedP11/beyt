//! Prevents the screen from turning off or going idle while video is playing.
//!
//! On Linux desktop, mpv renders via libmpv into a GtkGLArea without owning its
//! native window/compositor surface, so mpv's internal `stop-screensaver` does not
//! take effect. We inhibit the screensaver/idle monitor directly via D-Bus on the
//! session bus (`org.freedesktop.ScreenSaver`), with fallbacks to
//! `org.gnome.SessionManager` and `org.freedesktop.PowerManagement.Inhibit`.

#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
enum Backend {
    FreedesktopScreenSaver(u32),
    GnomeSessionManager(u32),
    FreedesktopPowerManagement(u32),
}

#[cfg(target_os = "linux")]
struct InhibitLock {
    conn: dbus::blocking::Connection,
    backend: Backend,
}

#[cfg(target_os = "linux")]
impl InhibitLock {
    fn release(&self) {
        match self.backend {
            Backend::FreedesktopScreenSaver(cookie) => {
                let proxy = self.conn.with_proxy(
                    "org.freedesktop.ScreenSaver",
                    "/org/freedesktop/ScreenSaver",
                    Duration::from_secs(2),
                );
                let _: Result<(), _> = proxy.method_call("org.freedesktop.ScreenSaver", "UnInhibit", (cookie,));
            }
            Backend::GnomeSessionManager(cookie) => {
                let proxy = self.conn.with_proxy(
                    "org.gnome.SessionManager",
                    "/org/gnome/SessionManager",
                    Duration::from_secs(2),
                );
                let _: Result<(), _> = proxy.method_call("org.gnome.SessionManager", "Uninhibit", (cookie,));
            }
            Backend::FreedesktopPowerManagement(cookie) => {
                let proxy = self.conn.with_proxy(
                    "org.freedesktop.PowerManagement.Inhibit",
                    "/org/freedesktop/PowerManagement/Inhibit",
                    Duration::from_secs(2),
                );
                let _: Result<(), _> = proxy.method_call(
                    "org.freedesktop.PowerManagement.Inhibit",
                    "UnInhibit",
                    (cookie,),
                );
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for InhibitLock {
    fn drop(&mut self) {
        self.release();
    }
}

pub struct ScreenInhibitor {
    #[cfg(target_os = "linux")]
    lock: std::sync::Mutex<Option<InhibitLock>>,
}

impl ScreenInhibitor {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            lock: std::sync::Mutex::new(None),
        }
    }

    /// Acquires the idle inhibitor if `inhibit` is true and not already held,
    /// or releases it if `inhibit` is false.
    pub fn set_inhibited(&self, inhibit: bool) {
        #[cfg(target_os = "linux")]
        {
            let mut guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            if inhibit && guard.is_none() {
                if let Some(lock) = Self::acquire() {
                    *guard = Some(lock);
                }
            } else if !inhibit && guard.is_some() {
                *guard = None;
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = inhibit;
        }
    }

    #[cfg(target_os = "linux")]
    fn acquire() -> Option<InhibitLock> {
        let conn = dbus::blocking::Connection::new_session().ok()?;

        // 1. Try org.freedesktop.ScreenSaver (standard for Wayland compositors including niri, KDE, XFCE)
        let proxy = conn.with_proxy(
            "org.freedesktop.ScreenSaver",
            "/org/freedesktop/ScreenSaver",
            Duration::from_secs(2),
        );
        if let Ok((cookie,)) = proxy.method_call::<(u32,), _, _, _>(
            "org.freedesktop.ScreenSaver",
            "Inhibit",
            ("Beyt", "Video playback"),
        ) {
            return Some(InhibitLock {
                conn,
                backend: Backend::FreedesktopScreenSaver(cookie),
            });
        }

        // 2. Try org.gnome.SessionManager
        let proxy = conn.with_proxy(
            "org.gnome.SessionManager",
            "/org/gnome/SessionManager",
            Duration::from_secs(2),
        );
        // Flags: 8 = suspend, 4 = idle
        if let Ok((cookie,)) = proxy.method_call::<(u32,), _, _, _>(
            "org.gnome.SessionManager",
            "Inhibit",
            ("Beyt", 0u32, "Video playback", 12u32),
        ) {
            return Some(InhibitLock {
                conn,
                backend: Backend::GnomeSessionManager(cookie),
            });
        }

        // 3. Try org.freedesktop.PowerManagement.Inhibit
        let proxy = conn.with_proxy(
            "org.freedesktop.PowerManagement.Inhibit",
            "/org/freedesktop/PowerManagement/Inhibit",
            Duration::from_secs(2),
        );
        if let Ok((cookie,)) = proxy.method_call::<(u32,), _, _, _>(
            "org.freedesktop.PowerManagement.Inhibit",
            "Inhibit",
            ("Beyt", "Video playback"),
        ) {
            return Some(InhibitLock {
                conn,
                backend: Backend::FreedesktopPowerManagement(cookie),
            });
        }

        None
    }
}

impl Default for ScreenInhibitor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_inhibitor_acquire_and_release() {
        let inhibitor = ScreenInhibitor::new();
        inhibitor.set_inhibited(true);
        // Repeated call should be idempotent
        inhibitor.set_inhibited(true);
        inhibitor.set_inhibited(false);
        // Repeated release should be idempotent
        inhibitor.set_inhibited(false);
    }
}
