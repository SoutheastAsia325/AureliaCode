package com.southeast.aureliacode.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** 窗口/页面 UI chrome 助手（自 MainActivity 拆出）：沉浸式状态栏、
 *  原生剪贴板、屏幕常亮、系统深色主题推送——均为无业务逻辑的纯 UI 状态读写。 */
internal class WebUiChrome(private val activity: MainActivity) {

  /** 沉浸式状态栏持久化读取（设置 → 通用设置 开关；默认收起）。 */
  fun immersivePrefs(): Boolean {
    return try {
      activity.getSharedPreferences("dsh_settings", Context.MODE_PRIVATE).getBoolean("immersive_mode", true)
    } catch (_: Exception) {
      true
    }
  }

  /** 状态栏常态收起（沉浸式）：隐藏系统栏，边缘滑动临时呼出后自动收起。 */
  fun applyImmersive(enabled: Boolean) {
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val controller = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
        if (enabled) {
          controller.hide(WindowInsetsCompat.Type.statusBars())
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
          controller.show(WindowInsetsCompat.Type.statusBars())
        }
      } else {
        val flags = if (enabled) {
          View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        } else {
          0
        }
        activity.window.decorView.systemUiVisibility = flags
      }
    } catch (t: Throwable) {
      Log.e("dsh-image", "applyImmersive failed: " + t.message)
    }
  }

  /** 沉浸式开关（JS 桥）：应用 + 持久化。 */
  fun setImmersivePersisted(enabled: Boolean) {
    activity.runOnUiThread { applyImmersive(enabled) }
    try {
      activity.getSharedPreferences("dsh_settings", Context.MODE_PRIVATE).edit().putBoolean("immersive_mode", enabled).apply()
      Log.i("dsh-image", "immersive set: " + enabled)
    } catch (e: Exception) {
      Log.e("dsh-image", "immersive persist failed: " + e.message)
    }
  }

  /** 0.13.3：textZoom 桥与持久化退役（D6）——上游 ui-theme fontSize 原生覆盖字体调节。 */

  /**
   * 原生剪贴板写入（WebView 的 Clipboard API 在 Android 上被拒
   * NotAllowedError: Write permission denied，页面回退到本桥）。
   */
  fun copyTextNative(text: String): Boolean {
    return try {
      val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      cm.setPrimaryClip(ClipData.newPlainText("dsh", text))
      Log.i("dsh-image", "copyTextNative ok, len=" + text.length)
      true
    } catch (e: Exception) {
      Log.e("dsh-image", "copyTextNative failed: " + e.message)
      false
    }
  }

  /** 屏幕常亮 WakeLock（JS 桥 keepScreenOn）。单例字段持有 + 成对
   *  acquire/release：旧实现每次调用 newWakeLock，新实例 isHeld 恒 false，
   *  关闭路径永不 release（Review 2026-08-18 实锤的锁泄漏）。 */
  private var screenWakeLock: PowerManager.WakeLock? = null

  fun keepScreenOn(enable: Boolean) {
    try {
      val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (enable && screenWakeLock == null) {
        screenWakeLock = power.newWakeLock(
          PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ON_AFTER_RELEASE,
          "dsh:screen",
        ).apply { acquire() }
      } else if (!enable && screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (t: Throwable) {
      Log.e("dsh-shell", "keepScreenOn failed: " + t.message)
    }
  }

  /** Activity 销毁兜底释放（原 onDestroy 的 screenWakeLock 释放块）。 */
  fun releaseWakeLock() {
    try {
      if (screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (_: Exception) {
    }
  }

  /** M7：主题延迟重推 Runnable 引用（onDestroy 取消用）。 */
  private var themeRetryRunnable: Runnable? = null

  /** 系统深色状态推送：某些厂商 WebView 的 prefers-color-scheme 不跟随
   *  uiMode（vivo/Android 16 实测），UI 插件经 matchMedia hook 消费此桥值
   *  （window.__dshThemeBridge.setDark）驱动上游 system 主题。
   *  推送时机加固（2026-08-16）：兜底桥（ui-responsive client bundle 内的
   *  ThemeBridge）可能晚于 onPageFinished 才安装——单次推送会静默落空
   *  （`window.__dshThemeBridge &&` 短路），主题不跟随。延迟 800ms 再推
   *  一次覆盖该时序；onResume 亦补推（覆盖从系统设置/SAF 返回后主题变化）。
   *  Runnable 体内 try/catch + onDestroy removeCallbacks（M7：防销毁后
   *  迟到的 evaluateJavascript 抛主线程异常）。 */
  fun pushSystemDark(view: WebView) {
    val dark = (activity.resources.configuration.uiMode and
      android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    try {
      view.evaluateJavascript(
        "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
      )
      themeRetryRunnable?.let { view.removeCallbacks(it) }
      val runnable = Runnable {
        try {
          view.evaluateJavascript(
            "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
          )
        } catch (_: Exception) {
          // 页面/WebView 已销毁：重推失败无害。
        }
      }
      themeRetryRunnable = runnable
      view.postDelayed(runnable, 800)
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再推一次。
    }
  }

  /** onDestroy 取消延迟重推（M7）。 */
  fun cancelThemePush(view: WebView) {
    themeRetryRunnable?.let { view.removeCallbacks(it) }
  }
}
