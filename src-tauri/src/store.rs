//! Local SQLite storage: watch positions, per-series subtitle settings and
//! app settings.

use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub struct Store {
    db: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchState {
    pub position: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub title: String,
    pub position: f64,
    pub duration: f64,
    /// Unix seconds.
    pub updated_at: i64,
}

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS watch (
        path       TEXT PRIMARY KEY,
        position   REAL NOT NULL,
        duration   REAL NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS series (
        folder   TEXT PRIMARY KEY,
        settings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
";

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let db = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::init(db)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> Result<Self> {
        db.execute_batch(SCHEMA).context("creating tables")?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn watch_state(&self, path: &str) -> Result<Option<WatchState>> {
        Ok(self
            .db()
            .query_row(
                "SELECT position, duration FROM watch WHERE path = ?1",
                [path],
                |r| Ok(WatchState { position: r.get(0)?, duration: r.get(1)? }),
            )
            .optional()?)
    }

    pub fn save_watch_state(&self, path: &str, position: f64, duration: f64) -> Result<()> {
        self.db().execute(
            "INSERT INTO watch (path, position, duration, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET position = ?2, duration = ?3, updated_at = ?4",
            params![path, position, duration, now()],
        )?;
        Ok(())
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<Recent>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT path, position, duration, updated_at FROM watch
             ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |r| {
            let path: String = r.get(0)?;
            let title = Path::new(&path)
                .file_stem()
                .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
            Ok(Recent {
                path,
                title,
                position: r.get(1)?,
                duration: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Per-series settings as JSON, owned by the frontend.
    pub fn series_settings(&self, folder: &str) -> Result<Option<serde_json::Value>> {
        let text: Option<String> = self
            .db()
            .query_row("SELECT settings FROM series WHERE folder = ?1", [folder], |r| r.get(0))
            .optional()?;
        Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
    }

    pub fn save_series_settings(&self, folder: &str, settings: &serde_json::Value) -> Result<()> {
        self.db().execute(
            "INSERT INTO series (folder, settings) VALUES (?1, ?2)
             ON CONFLICT(folder) DO UPDATE SET settings = ?2",
            params![folder, settings.to_string()],
        )?;
        Ok(())
    }

    pub fn app_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        let db = self.db();
        let mut stmt = db.prepare("SELECT key, value FROM app_settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (key, value) = row?;
            out.insert(key, serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value)));
        }
        Ok(out)
    }

    pub fn set_app_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.db().execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value.to_string()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_state_round_trip() {
        let store = Store::in_memory().unwrap();
        assert!(store.watch_state("/a.mkv").unwrap().is_none());
        store.save_watch_state("/a.mkv", 10.0, 100.0).unwrap();
        store.save_watch_state("/a.mkv", 42.5, 100.0).unwrap();
        let s = store.watch_state("/a.mkv").unwrap().unwrap();
        assert_eq!((s.position, s.duration), (42.5, 100.0));
        let recent = store.recent(10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title, "a");
    }

    #[test]
    fn series_and_app_settings() {
        let store = Store::in_memory().unwrap();
        let v = serde_json::json!({"tracks": {"fa:file:0": {"offset": 0.3}}});
        store.save_series_settings("/shows/x", &v).unwrap();
        assert_eq!(store.series_settings("/shows/x").unwrap(), Some(v));
        store.set_app_setting("uiLanguage", &serde_json::json!("fa")).unwrap();
        assert_eq!(store.app_settings().unwrap()["uiLanguage"], "fa");
    }
}
