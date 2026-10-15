package app.beyt.player

// Beyt's Android video player. Media3 ExoPlayer draws into a SurfaceView
// under the webview, whose page is transparent while a video plays: the same
// layering as mpv under WebKitGTK on the desktop. Rust drives it from
// src-tauri/src/player_android.rs; every command runs on the UI thread.

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private lateinit var player: ExoPlayer
  private lateinit var stage: FrameLayout
  private lateinit var surface: SurfaceView

  /** mpv's volume runs to 130; ExoPlayer's stops at 1, so this keeps the asked-for value. */
  private var volume = 100.0
  private var muted = false
  private var lastError: String? = null

  override fun load(webView: WebView) {
    // Black behind the video; the surface is sized to the video's shape.
    stage = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
    surface = SurfaceView(activity)
    stage.addView(surface, FrameLayout.LayoutParams(0, 0, Gravity.CENTER))
    stage.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitSurface() }

    // The page shows through wherever it is transparent.
    webView.setBackgroundColor(Color.TRANSPARENT)
    val root = webView.parent as ViewGroup
    root.addView(stage, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    player = ExoPlayer.Builder(activity).build().apply {
      setVideoSurfaceView(surface)
      addListener(object : Player.Listener {
        override fun onVideoSizeChanged(videoSize: VideoSize) = fitSurface()

        override fun onIsPlayingChanged(isPlaying: Boolean) {
          // Keep the screen on while a video plays, as other players do.
          if (isPlaying) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          }
        }

        override fun onPlayerError(error: PlaybackException) {
          lastError = error.cause?.message ?: error.message ?: error.errorCodeName
        }
      })
    }
  }

  /** Letterboxes the surface so the video keeps its shape. */
  private fun fitSurface() {
    val size = player.videoSize
    val (w, h) = stage.width to stage.height
    if (size.width == 0 || size.height == 0 || w == 0 || h == 0) return
    val aspect = size.width * size.pixelWidthHeightRatio / size.height
    val (sw, sh) = if (w.toFloat() / h > aspect) (h * aspect).toInt() to h else w to (w / aspect).toInt()
    val params = surface.layoutParams as FrameLayout.LayoutParams
    if (params.width != sw || params.height != sh) {
      params.width = sw
      params.height = sh
      surface.layoutParams = params
    }
  }

  // Phones stop video when the app goes to the background.
  override fun onPause(activity: AppCompatActivity) {
    if (::player.isInitialized) player.pause()
  }

  override fun onDestroy(activity: AppCompatActivity) {
    if (::player.isInitialized) player.release()
  }

  // ---------- commands from player_android.rs ----------

  @Command
  fun open(invoke: Invoke) {
    val args = invoke.getArgs()
    val path = args.getString("path")
    val uri = if (path.contains("://")) Uri.parse(path) else Uri.fromFile(File(path))
    lastError = null
    player.setMediaItem(MediaItem.fromUri(uri), (args.optDouble("start", 0.0) * 1000).toLong())
    player.playWhenReady = !args.getBoolean("paused", false)
    player.prepare()
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    player.stop()
    player.clearMediaItems()
    invoke.resolve()
  }

  /** Applies whichever of the settings are given. */
  @Command
  fun set(invoke: Invoke) {
    val args = invoke.getArgs()
    if (args.has("paused")) player.playWhenReady = !args.getBoolean("paused")
    if (args.has("position")) {
      // A finished video plays again from where it is sought to.
      if (player.playbackState == Player.STATE_ENDED) player.prepare()
      player.seekTo((args.getDouble("position") * 1000).toLong())
    }
    if (args.has("speed")) player.playbackParameters = PlaybackParameters(args.getDouble("speed").toFloat())
    if (args.has("volume")) volume = args.getDouble("volume")
    if (args.has("mute")) muted = args.getBoolean("mute")
    player.volume = if (muted) 0f else (volume / 100).coerceIn(0.0, 1.0).toFloat()
    if (args.has("brightness")) {
      // 0–1 sets the screen's brightness for this app; below 0 follows the system.
      val attrs = activity.window.attributes
      attrs.screenBrightness = args.getDouble("brightness").toFloat()
      activity.window.attributes = attrs
    }
    invoke.resolve()
  }

  @Command
  fun state(invoke: Invoke) {
    val duration = player.duration
    invoke.resolve(JSObject().apply {
      put("time", player.currentPosition / 1000.0)
      put("paused", !player.playWhenReady)
      put("speed", player.playbackParameters.speed.toDouble())
      put("duration", if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0)
      put("eof", player.playbackState == Player.STATE_ENDED)
      put("volume", volume)
      put("mute", muted)
      put("error", lastError)
    })
  }

  // ---------- storage ----------

  /** Beyt reads videos and the subtitle files next to them by path, which needs all-files access. */
  private fun hasStorageAccess(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

  @Command
  fun storageAccess(invoke: Invoke) {
    invoke.resolve(JSObject().apply {
      put("granted", hasStorageAccess())
      put("root", Environment.getExternalStorageDirectory().absolutePath)
    })
  }

  /** Opens the system's permission screen; the page checks again when Beyt is back in front. */
  @Command
  fun requestStorageAccess(invoke: Invoke) {
    if (!hasStorageAccess()) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
        try {
          activity.startActivity(intent)
        } catch (e: Exception) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
      } else {
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE), 1)
      }
    }
    invoke.resolve()
  }
}
