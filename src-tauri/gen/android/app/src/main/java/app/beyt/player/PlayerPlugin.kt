package app.beyt.player

// Beyt's Android video player. Media3 ExoPlayer draws into a SurfaceView
// under the webview, whose page is transparent while a video plays: the same
// layering as mpv under WebKitGTK on the desktop. Rust drives it from
// src-tauri/src/player_android.rs; every command runs on the UI thread.

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.MetadataRetriever
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import org.json.JSONArray

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private lateinit var player: ExoPlayer
  private lateinit var stage: FrameLayout
  private lateinit var surface: SurfaceView

  /** mpv's volume runs to 130; ExoPlayer's stops at 1, so this keeps the asked-for value. */
  private var volume = 100.0
  private var muted = false
  private var lastError: String? = null
  /** The picture's shape: `original`, a ratio like `16:9`, `fill` or `stretch`. */
  private var aspect = "original"

  override fun load(webView: WebView) {
    // Black behind the video; the surface is sized to the video's shape. It
    // starts full size: an empty surface gets no buffers, and ExoPlayer only
    // reports the video's size once it has drawn a frame.
    stage = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
    surface = SurfaceView(activity)
    stage.addView(surface, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
    stage.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitSurface() }

    // The page shows through wherever it is transparent.
    webView.setBackgroundColor(Color.TRANSPARENT)
    // The app draws edge to edge; keep the page clear of the status and
    // navigation bars, while the video behind it still fills the screen.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      (view.layoutParams as ViewGroup.MarginLayoutParams).setMargins(bars.left, bars.top, bars.right, bars.bottom)
      view.requestLayout()
      insets
    }
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

  /** Sizes the surface for the picture shape in `aspect`. Letterboxed shapes
   *  fit inside the screen; `fill` covers it, with the overflow cut off. */
  private fun fitSurface() {
    val size = player.videoSize
    val (w, h) = stage.width to stage.height
    if (size.width == 0 || size.height == 0 || w == 0 || h == 0) return
    val natural = size.width * size.pixelWidthHeightRatio / size.height
    val ratio = aspect.split(":").mapNotNull { it.toFloatOrNull() }
      .takeIf { it.size == 2 && it[1] > 0 }?.let { it[0] / it[1] }
    val (shape, cover) = when (aspect) {
      "fill" -> natural to true
      else -> (ratio ?: natural) to false
    }
    val (sw, sh) = when {
      aspect == "stretch" -> w to h
      (w.toFloat() / h > shape) != cover -> (h * shape).toInt() to h
      else -> w to (w / shape).toInt()
    }
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
    stage.visibility = View.VISIBLE
    player.setMediaItem(MediaItem.fromUri(uri), (args.optDouble("start", 0.0) * 1000).toLong())
    player.playWhenReady = !args.getBoolean("paused", false)
    player.prepare()
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    player.stop()
    player.clearMediaItems()
    // A surface keeps its last frame, which would show around the library.
    stage.visibility = View.GONE
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
    if (args.has("aspect")) {
      aspect = args.getString("aspect")
      fitSurface()
    }
    if (args.has("brightness")) {
      // 0–1 sets the screen's brightness for this app; below 0 follows the system.
      val attrs = activity.window.attributes
      attrs.screenBrightness = args.getDouble("brightness").toFloat()
      activity.window.attributes = attrs
    }
    invoke.resolve()
  }

  /** Beyt's screen brightness (0–1): its own if it has set one, else the phone's. */
  @Command
  fun brightness(invoke: Invoke) {
    val own = activity.window.attributes.screenBrightness
    val level = if (own >= 0) {
      own.toDouble()
    } else {
      try {
        Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS) / 255.0
      } catch (e: Settings.SettingNotFoundException) {
        0.5
      }
    }
    invoke.resolve(JSObject().apply { put("level", level.coerceIn(0.0, 1.0)) })
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
      put("keyboard", hasHardKeyboard())
    })
  }

  /** A physical keyboard is attached (USB or Bluetooth), not just the on-screen one.
   *  The activity handles keyboard changes itself, so its configuration stays current. */
  private fun hasHardKeyboard(): Boolean {
    val config = activity.resources.configuration
    return config.keyboard == Configuration.KEYBOARD_QWERTY &&
      config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
  }

  /** Back in the library leaves Beyt the way Android 12+ leaves any app: in the background, still open. */
  @Command
  fun moveToBack(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve()
  }

  // ---------- thumbnails ----------

  /** Writes a JPEG of one frame to `out`, `width` pixels wide, for library.rs.
   *  Without `at` (seconds), or past the end, the frame comes from 15% in, and
   *  failing that the start. Decoding is slow, so it runs off the UI thread. */
  @Command
  fun thumbnail(invoke: Invoke) {
    val args = invoke.getArgs()
    val path = args.getString("path")
    val out = args.getString("out")
    val width = args.optInt("width", 480)
    val at = if (args.isNull("at")) null else args.optDouble("at")
    Thread {
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(path)
        val length = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        val wanted = at?.let { (it * 1_000_000).toLong() }?.takeIf { length == 0L || it < length * 1000 }
        val frame = listOf(wanted ?: length * 150, 0L).firstNotNullOfOrNull { frameAt(retriever, it, width) }
          ?: throw IllegalStateException("no frame could be read from $path")
        File(out).outputStream().use { frame.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        frame.recycle()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      } finally {
        retriever.release()
      }
    }.start()
  }

  /** The frame nearest `us` microseconds in, scaled down to `width` pixels wide. */
  private fun frameAt(retriever: MediaMetadataRetriever, us: Long, width: Int): Bitmap? {
    val option = MediaMetadataRetriever.OPTION_CLOSEST_SYNC
    // Scaling while decoding saves holding a full 4K frame in memory.
    val frame = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      retriever.getScaledFrameAtTime(us, option, width, width * 4)
    } else {
      retriever.getFrameAtTime(us, option)
    } ?: return null
    if (frame.width <= width) return frame
    val scaled = Bitmap.createScaledBitmap(frame, width, frame.height * width / frame.width, true)
    frame.recycle()
    return scaled
  }

  // ---------- soundtrack ----------

  /** Decodes `length` seconds of the first audio track from `start` (both in
   *  seconds) with the phone's own decoders, and writes them to `out` as mono
   *  16-bit little-endian samples, for sync.rs in place of ffmpeg. Resolves
   *  with their sample `rate`. Decoding is slow, so it runs off the UI thread. */
  @Command
  fun decodeAudio(invoke: Invoke) {
    val args = invoke.getArgs()
    val path = args.getString("path")
    val out = args.getString("out")
    val startUs = (args.optDouble("start", 0.0) * 1_000_000).toLong()
    val endUs = startUs + (args.optDouble("length", 0.0) * 1_000_000).toLong()
    Thread {
      val extractor = MediaExtractor()
      var codec: MediaCodec? = null
      try {
        extractor.setDataSource(path)
        val track = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: throw IllegalStateException("no audio track")
        extractor.selectTrack(track)
        val input = extractor.getTrackFormat(track)
        val decoder = MediaCodec.createDecoderByType(input.getString(MediaFormat.KEY_MIME)!!)
        codec = decoder
        decoder.configure(input, null, null, 0)
        decoder.start()
        extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

        var rate = input.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = input.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var isFloat = false
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        BufferedOutputStream(FileOutputStream(out)).use { sink ->
          while (!outputDone) {
            if (!inputDone) {
              val i = decoder.dequeueInputBuffer(10_000)
              if (i >= 0) {
                val size = extractor.readSampleData(decoder.getInputBuffer(i)!!, 0)
                if (size < 0 || extractor.sampleTime > endUs) {
                  decoder.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                  inputDone = true
                } else {
                  decoder.queueInputBuffer(i, 0, size, extractor.sampleTime, 0)
                  extractor.advance()
                }
              }
            }
            val o = decoder.dequeueOutputBuffer(info, 10_000)
            if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
              val format = decoder.outputFormat
              rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              isFloat = format.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                format.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
            } else if (o >= 0) {
              val buffer = decoder.getOutputBuffer(o)!!
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              writeMono(buffer.slice().order(ByteOrder.nativeOrder()), info.presentationTimeUs, startUs, endUs, rate, channels, isFloat, sink)
              decoder.releaseOutputBuffer(o, false)
              if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
            }
          }
        }
        invoke.resolve(JSObject().apply { put("rate", rate) })
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      } finally {
        try { codec?.stop() } catch (_: Exception) {}
        codec?.release()
        extractor.release()
      }
    }.start()
  }

  /** Writes the frames of one decoded buffer that fall between `startUs` and
   *  `endUs`, each the average of its channels, as 16-bit little-endian. */
  private fun writeMono(
    pcm: ByteBuffer, ptsUs: Long, startUs: Long, endUs: Long,
    rate: Int, channels: Int, isFloat: Boolean, sink: BufferedOutputStream,
  ) {
    val samples = if (isFloat) pcm.remaining() / 4 else pcm.remaining() / 2
    val frames = samples / channels
    val floats = if (isFloat) pcm.asFloatBuffer() else null
    val shorts = if (isFloat) null else pcm.asShortBuffer()
    val bytes = ByteArray(frames * 2)
    var n = 0
    for (f in 0 until frames) {
      val at = ptsUs + f * 1_000_000L / rate
      if (at < startUs) continue
      if (at >= endUs) break
      var sum = 0.0
      for (c in 0 until channels) {
        val i = f * channels + c
        sum += if (floats != null) floats.get(i) * 32767.0 else shorts!!.get(i).toDouble()
      }
      val s = (sum / channels).roundToInt().coerceIn(-32768, 32767)
      bytes[n++] = (s and 0xff).toByte()
      bytes[n++] = (s shr 8 and 0xff).toByte()
    }
    sink.write(bytes, 0, n)
  }

  // ---------- file details ----------

  /** Describes `path` the way `ffprobe -show_format -show_streams -of json`
   *  does, for info.rs: Media3's extractors read the streams, the same ones
   *  that play the video. Reading the file is slow, so it runs off the UI thread. */
  @Command
  fun probe(invoke: Invoke) {
    val path = invoke.getArgs().getString("path")
    Thread {
      try {
        val item = MediaItem.fromUri(Uri.fromFile(File(path)))
        val (groups, durationUs) = MetadataRetriever.Builder(activity, item).build().use {
          it.retrieveTrackGroups().get(20, TimeUnit.SECONDS) to it.retrieveDurationUs().get(20, TimeUnit.SECONDS)
        }
        val streams = JSONArray()
        var container: String? = null
        for (i in 0 until groups.length) {
          val group = groups[i]
          for (j in 0 until group.length) {
            val format = group.getFormat(j)
            container = container ?: format.containerMimeType
            stream(group.type, format)?.let { streams.put(it) }
          }
        }
        val seconds = if (durationUs == C.TIME_UNSET || durationUs <= 0) null else durationUs / 1e6
        val (title, bitrate) = fileTags(path)
        invoke.resolve(JSObject().apply {
          put("format", JSObject().apply {
            formatName(container, path)?.let { put("format_name", it) }
            seconds?.let { put("duration", it.toString()) }
            // Matroska keeps no overall bitrate; ffprobe works it out the same way.
            (bitrate ?: seconds?.let { (File(path).length() * 8 / it).toLong() })?.let { put("bit_rate", it.toString()) }
            put("tags", JSObject().apply { title?.let { put("title", it) } })
          })
          put("streams", streams)
        })
      } catch (e: Exception) {
        invoke.reject((e.cause ?: e).message ?: e.toString())
      }
    }.start()
  }

  /** One stream as ffprobe lists it, or null for kinds info.rs doesn't show. */
  private fun stream(type: Int, format: Format): JSObject? {
    val kind = when (type) {
      C.TRACK_TYPE_VIDEO -> "video"
      C.TRACK_TYPE_AUDIO -> "audio"
      C.TRACK_TYPE_TEXT -> "subtitle"
      else -> return null
    }
    // Text subtitles are turned into cues while being read; `codecs` keeps their own type.
    val mime = if (format.sampleMimeType == MimeTypes.APPLICATION_MEDIA3_CUES) format.codecs else format.sampleMimeType
    return JSObject().apply {
      put("codec_type", kind)
      put("codec_name", codecName(mime))
      put("tags", JSObject().apply {
        format.language?.let { put("language", it) }
        format.label?.let { put("title", it) }
      })
      put("disposition", JSObject().apply {
        put("default", if (format.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0) 1 else 0)
        put("forced", if (format.selectionFlags and C.SELECTION_FLAG_FORCED != 0) 1 else 0)
      })
      when (kind) {
        "video" -> {
          if (format.width > 0) put("width", format.width)
          if (format.height > 0) put("height", format.height)
          if (format.frameRate > 0) put("avg_frame_rate", "${(format.frameRate * 1000).roundToInt()}/1000")
          videoProfile(format.codecs)?.let { put("profile", it) }
          format.colorInfo?.let { color ->
            if (color.lumaBitdepth > 0) put("bits_per_raw_sample", color.lumaBitdepth.toString())
            when (color.colorTransfer) {
              C.COLOR_TRANSFER_ST2084 -> put("color_transfer", "smpte2084")
              C.COLOR_TRANSFER_HLG -> put("color_transfer", "arib-std-b67")
              else -> {}
            }
          }
        }
        "audio" -> {
          if (format.channelCount > 0) put("channels", format.channelCount)
          if (format.sampleRate > 0) put("sample_rate", format.sampleRate.toString())
        }
      }
    }
  }

  /** The container's title tag and overall bitrate, where Android can read them. */
  private fun fileTags(path: String): Pair<String?, Long?> {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(path)
      val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
      val bitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull()
      title to bitrate
    } catch (e: Exception) {
      null to null
    } finally {
      retriever.release()
    }
  }

  /** ffprobe's format names, which info.rs and the dialog know. */
  private fun formatName(container: String?, path: String): String? = when (container) {
    MimeTypes.VIDEO_MATROSKA, MimeTypes.VIDEO_WEBM, MimeTypes.AUDIO_MATROSKA, MimeTypes.AUDIO_WEBM -> "matroska,webm"
    MimeTypes.VIDEO_MP4, MimeTypes.AUDIO_MP4 -> "mov,mp4,m4a,3gp,3g2,mj2"
    MimeTypes.VIDEO_AVI -> "avi"
    MimeTypes.VIDEO_MP2T -> "mpegts"
    else -> when (path.substringAfterLast('.', "").lowercase()) {
      "mkv", "webm" -> "matroska,webm"
      "mp4", "m4v", "mov" -> "mov,mp4,m4a,3gp,3g2,mj2"
      "avi" -> "avi"
      "ts", "m2ts" -> "mpegts"
      else -> container
    }
  }

  /** ffprobe's codec names for Android's MIME types. */
  private fun codecName(mime: String?): String = when (mime) {
    null -> "unknown"
    MimeTypes.VIDEO_H264 -> "h264"
    MimeTypes.VIDEO_H265, MimeTypes.VIDEO_DOLBY_VISION -> "hevc"
    MimeTypes.VIDEO_AV1 -> "av1"
    MimeTypes.VIDEO_VP9 -> "vp9"
    MimeTypes.VIDEO_VP8 -> "vp8"
    MimeTypes.VIDEO_MP4V -> "mpeg4"
    MimeTypes.VIDEO_MPEG2 -> "mpeg2video"
    MimeTypes.AUDIO_AAC -> "aac"
    MimeTypes.AUDIO_AC3 -> "ac3"
    MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "eac3"
    MimeTypes.AUDIO_TRUEHD -> "truehd"
    MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_EXPRESS -> "dts"
    MimeTypes.AUDIO_OPUS -> "opus"
    MimeTypes.AUDIO_VORBIS -> "vorbis"
    MimeTypes.AUDIO_FLAC -> "flac"
    MimeTypes.AUDIO_MPEG -> "mp3"
    MimeTypes.AUDIO_RAW -> "pcm_s16le"
    MimeTypes.APPLICATION_SUBRIP -> "subrip"
    MimeTypes.TEXT_SSA -> "ass"
    MimeTypes.TEXT_VTT -> "webvtt"
    MimeTypes.APPLICATION_TX3G -> "mov_text"
    MimeTypes.APPLICATION_PGS -> "hdmv_pgs_subtitle"
    MimeTypes.APPLICATION_VOBSUB -> "dvd_subtitle"
    MimeTypes.APPLICATION_DVBSUBS -> "dvb_subtitle"
    else -> mime.substringAfter('/').removePrefix("x-")
  }

  /** The profile from an RFC 6381 codec string: "avc1.640028" → "High", "hvc1.2.4.L120" → "Main 10". */
  private fun videoProfile(codecs: String?): String? {
    val parts = codecs?.split('.') ?: return null
    return when (parts[0]) {
      "avc1", "avc3" -> when (parts.getOrNull(1)?.take(2)?.toIntOrNull(16)) {
        66 -> "Baseline"
        77 -> "Main"
        88 -> "Extended"
        100 -> "High"
        110 -> "High 10"
        122 -> "High 4:2:2"
        244 -> "High 4:4:4 Predictive"
        else -> null
      }
      "hvc1", "hev1" -> when (parts.getOrNull(1)?.trimStart('A', 'B', 'C')?.toIntOrNull()) {
        1 -> "Main"
        2 -> "Main 10"
        3 -> "Main Still Picture"
        4 -> "Rext"
        else -> null
      }
      else -> null
    }
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
