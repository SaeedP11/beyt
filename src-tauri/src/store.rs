//! Local SQLite storage: watch positions, subtitle and audio files added by hand,
//! per-series subtitle settings and app settings.

use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

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
    CREATE TABLE IF NOT EXISTS added_subtitles (
        video TEXT NOT NULL,
        path  TEXT NOT NULL,
        PRIMARY KEY (video, path)
    );
    CREATE TABLE IF NOT EXISTS added_audio (
        video TEXT NOT NULL,
        path  TEXT NOT NULL,
        PRIMARY KEY (video, path)
    );
    CREATE TABLE IF NOT EXISTS series (
        folder   TEXT PRIMARY KEY,
        settings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vocab (
        id          INTEGER PRIMARY KEY,
        word        TEXT,              -- NULL when a whole line was saved
        meaning     TEXT,
        sentence    TEXT NOT NULL,
        translation TEXT,
        lang        TEXT NOT NULL,
        video       TEXT NOT NULL,
        start       REAL NOT NULL,
        end         REAL NOT NULL,
        screenshot  TEXT,              -- file name in the vocab media folder
        audio       TEXT,
        created_at  INTEGER NOT NULL,
        exported    INTEGER NOT NULL DEFAULT 0
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

    pub fn clear_watch_history(&self) -> Result<()> {
        self.db().execute("DELETE FROM watch", [])?;
        Ok(())
    }

    /// Drops one file's watch position, taking it off Continue watching.
    pub fn forget_watch(&self, path: &str) -> Result<()> {
        self.db().execute("DELETE FROM watch WHERE path = ?1", [path])?;
        Ok(())
    }

    /// Points everything stored about renamed files at their new paths: the
    /// watch position, added subtitles and saved vocabulary.
    pub fn rename_paths(&self, moves: &[(String, String)]) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for (from, to) in moves {
            tx.execute("UPDATE OR REPLACE watch SET path = ?2 WHERE path = ?1", params![from, to])?;
            tx.execute("UPDATE OR REPLACE added_subtitles SET video = ?2 WHERE video = ?1", params![from, to])?;
            tx.execute("UPDATE OR REPLACE added_subtitles SET path = ?2 WHERE path = ?1", params![from, to])?;
            tx.execute("UPDATE OR REPLACE added_audio SET video = ?2 WHERE video = ?1", params![from, to])?;
            tx.execute("UPDATE OR REPLACE added_audio SET path = ?2 WHERE path = ?1", params![from, to])?;
            tx.execute("UPDATE vocab SET video = ?2 WHERE video = ?1", params![from, to])?;
        }
        tx.commit()?;
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

    /// Subtitle files the user added to `video`, in the order they were added.
    pub fn added_subtitles(&self, video: &str) -> Result<Vec<String>> {
        let db = self.db();
        let mut stmt = db.prepare("SELECT path FROM added_subtitles WHERE video = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map([video], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_subtitle(&self, video: &str, path: &str) -> Result<()> {
        self.db().execute(
            "INSERT OR IGNORE INTO added_subtitles (video, path) VALUES (?1, ?2)",
            params![video, path],
        )?;
        Ok(())
    }

    pub fn remove_subtitle(&self, video: &str, path: &str) -> Result<()> {
        self.db().execute(
            "DELETE FROM added_subtitles WHERE video = ?1 AND path = ?2",
            params![video, path],
        )?;
        Ok(())
    }

    pub fn added_audio(&self, video: &str) -> Result<Vec<String>> {
        let db = self.db();
        let mut stmt = db.prepare("SELECT path FROM added_audio WHERE video = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map([video], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_audio(&self, video: &str, path: &str) -> Result<()> {
        self.db().execute("INSERT OR IGNORE INTO added_audio (video, path) VALUES (?1, ?2)", params![video, path])?;
        Ok(())
    }

    pub fn remove_audio(&self, video: &str, path: &str) -> Result<()> {
        self.db().execute("DELETE FROM added_audio WHERE video = ?1 AND path = ?2", params![video, path])?;
        Ok(())
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

/// A word or line the user saved, before its media is captured.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVocab {
    pub word: Option<String>,
    pub meaning: Option<String>,
    pub sentence: String,
    pub translation: Option<String>,
    pub lang: String,
    pub video: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabItem {
    pub id: i64,
    pub word: Option<String>,
    pub meaning: Option<String>,
    pub sentence: String,
    pub translation: Option<String>,
    pub lang: String,
    pub video: String,
    pub start: f64,
    pub end: f64,
    /// File names in the vocab media folder.
    pub screenshot: Option<String>,
    pub audio: Option<String>,
    pub created_at: i64,
    pub exported: bool,
}

impl Store {
    pub fn add_vocab(&self, v: &NewVocab) -> Result<i64> {
        let db = self.db();
        db.execute(
            "INSERT INTO vocab (word, meaning, sentence, translation, lang, video, start, end, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![v.word, v.meaning, v.sentence, v.translation, v.lang, v.video, v.start, v.end, now()],
        )?;
        Ok(db.last_insert_rowid())
    }

    pub fn set_vocab_media(&self, id: i64, screenshot: Option<&str>, audio: Option<&str>) -> Result<()> {
        self.db().execute(
            "UPDATE vocab SET screenshot = ?2, audio = ?3 WHERE id = ?1",
            params![id, screenshot, audio],
        )?;
        Ok(())
    }

    /// Newest first.
    pub fn list_vocab(&self) -> Result<Vec<VocabItem>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT id, word, meaning, sentence, translation, lang, video, start, end,
                    screenshot, audio, created_at, exported
             FROM vocab ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(VocabItem {
                id: r.get(0)?,
                word: r.get(1)?,
                meaning: r.get(2)?,
                sentence: r.get(3)?,
                translation: r.get(4)?,
                lang: r.get(5)?,
                video: r.get(6)?,
                start: r.get(7)?,
                end: r.get(8)?,
                screenshot: r.get(9)?,
                audio: r.get(10)?,
                created_at: r.get(11)?,
                exported: r.get::<_, i64>(12)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Removes an item, returning it so its media files can be deleted.
    pub fn delete_vocab(&self, id: i64) -> Result<Option<VocabItem>> {
        let item = self.list_vocab()?.into_iter().find(|v| v.id == id);
        self.db().execute("DELETE FROM vocab WHERE id = ?1", [id])?;
        Ok(item)
    }

    pub fn mark_exported(&self, ids: &[i64]) -> Result<()> {
        let db = self.db();
        for id in ids {
            db.execute("UPDATE vocab SET exported = 1 WHERE id = ?1", [id])?;
        }
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
    fn renaming_and_forgetting_files() {
        let store = Store::in_memory().unwrap();
        store.save_watch_state("/a.mkv", 10.0, 100.0).unwrap();
        store.add_subtitle("/a.mkv", "/a.fa.srt").unwrap();
        let moves = [("/a.mkv".to_string(), "/b.mkv".to_string()), ("/a.fa.srt".to_string(), "/b.fa.srt".to_string())];
        store.rename_paths(&moves).unwrap();
        assert!(store.watch_state("/a.mkv").unwrap().is_none());
        assert_eq!(store.watch_state("/b.mkv").unwrap().unwrap().position, 10.0);
        assert_eq!(store.added_subtitles("/b.mkv").unwrap(), ["/b.fa.srt"]);
        store.forget_watch("/b.mkv").unwrap();
        assert!(store.recent(10).unwrap().is_empty());
    }

    #[test]
    fn added_subtitles_keep_their_order() {
        let store = Store::in_memory().unwrap();
        store.add_subtitle("/v.mkv", "/subs/b.srt").unwrap();
        store.add_subtitle("/v.mkv", "/subs/a.srt").unwrap();
        store.add_subtitle("/v.mkv", "/subs/b.srt").unwrap();
        store.add_subtitle("/w.mkv", "/subs/c.srt").unwrap();
        assert_eq!(store.added_subtitles("/v.mkv").unwrap(), ["/subs/b.srt", "/subs/a.srt"]);
        assert!(store.added_subtitles("/x.mkv").unwrap().is_empty());
        store.remove_subtitle("/v.mkv", "/subs/b.srt").unwrap();
        assert_eq!(store.added_subtitles("/v.mkv").unwrap(), ["/subs/a.srt"]);
        assert_eq!(store.added_subtitles("/w.mkv").unwrap(), ["/subs/c.srt"]);
    }

    #[test]
    fn added_audio_follows_renames() {
        let store = Store::in_memory().unwrap();
        store.add_audio("/a.mkv", "/dub/a.fa.mka").unwrap();
        store.add_audio("/a.mkv", "/dub/a.fa.mka").unwrap();
        store.rename_paths(&[("/a.mkv".to_string(), "/b.mkv".to_string())]).unwrap();
        assert!(store.added_audio("/a.mkv").unwrap().is_empty());
        assert_eq!(store.added_audio("/b.mkv").unwrap(), ["/dub/a.fa.mka"]);
        store.remove_audio("/b.mkv", "/dub/a.fa.mka").unwrap();
        assert!(store.added_audio("/b.mkv").unwrap().is_empty());
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

    #[test]
    fn vocab_round_trip() {
        let store = Store::in_memory().unwrap();
        let id = store
            .add_vocab(&NewVocab {
                word: Some("run".into()),
                meaning: Some("دویدن".into()),
                sentence: "I run every day".into(),
                translation: Some("هر روز می‌دوم".into()),
                lang: "en".into(),
                video: "/v.mkv".into(),
                start: 1.0,
                end: 2.5,
            })
            .unwrap();
        store.set_vocab_media(id, Some("a.jpg"), Some("a.mp3")).unwrap();
        store.mark_exported(&[id]).unwrap();
        let items = store.list_vocab().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].screenshot.as_deref(), Some("a.jpg"));
        assert!(items[0].exported);
        assert!(store.delete_vocab(id).unwrap().is_some());
        assert!(store.list_vocab().unwrap().is_empty());
    }
}
