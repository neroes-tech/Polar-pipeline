package com.neroes.hrv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * Ticks the recording notification once a second using a native Handler,
 * independent of the WebView's own JS timers.
 *
 * Chromium throttles setInterval/setTimeout to almost nothing once the page
 * is hidden — this is a documented, deliberate battery-saving behaviour
 * ("Intensive Timer Throttling") and it applies even with a foreground
 * service keeping the process alive, because it targets the WebView's JS
 * engine, not the process. A notification driven only from JS visibly
 * freezes after a couple of minutes in background as a result.
 *
 * A Handler tied to the main Looper is pure Android OS scheduling — it has
 * nothing to do with the WebView's JS engine and is not subject to that
 * throttling. This plugin owns the "what time is it relative to session
 * start" math on the native side, which it can always compute correctly by
 * itself from a single timestamp, with no dependency on the WebView ever
 * being responsive again. JS still pushes the latest bpm/connection status
 * via updateBpm() whenever it gets the chance to run; if it's throttled and
 * doesn't, the notification still keeps ticking the time correctly, just
 * without a fresher bpm — never frozen.
 */
@CapacitorPlugin(name = "NotificationTicker")
public class NotificationTickerPlugin extends Plugin {

    private static final String CHANNEL_ID = "neroes_recording";
    private static final int NOTIFICATION_ID = 1;
    private static final int REST_DURATION_S = 300;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable tickRunnable;

    private long startedAtMillis = 0;
    private String sessionType = "free";
    private Integer bpm = null;
    private String bleStatus = "connected";

    @PluginMethod
    public void start(PluginCall call) {
        Long startedAt = call.getLong("startedAt", System.currentTimeMillis());
        startedAtMillis = startedAt != null ? startedAt : System.currentTimeMillis();
        sessionType = call.getString("sessionType", "free");
        bpm = null;
        bleStatus = "connected";
        ensureChannel();
        stopTicking();
        tickRunnable = new Runnable() {
            @Override
            public void run() {
                postNotification();
                handler.postDelayed(this, 1000);
            }
        };
        handler.post(tickRunnable);
        call.resolve();
    }

    @PluginMethod
    public void updateBpm(PluginCall call) {
        bpm = call.hasOption("bpm") ? call.getInt("bpm") : null;
        bleStatus = call.getString("status", "connected");
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopTicking();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopTicking();
        super.handleOnDestroy();
    }

    private void stopTicking() {
        if (tickRunnable != null) {
            handler.removeCallbacks(tickRunnable);
            tickRunnable = null;
        }
    }

    private String sessionTypeLabel() {
        return "rest_5min".equals(sessionType) ? "Sessão de 5 min" : "Sessão livre";
    }

    private String fmtTime(int totalSeconds) {
        int m = totalSeconds / 60;
        int s = totalSeconds % 60;
        return String.format(Locale.ROOT, "%02d:%02d", m, s);
    }

    private void postNotification() {
        Context context = getContext();
        if (context == null) return;

        long elapsedS = (System.currentTimeMillis() - startedAtMillis) / 1000;
        int displaySecs = "rest_5min".equals(sessionType)
            ? (int) Math.max(0, REST_DURATION_S - elapsedS)
            : (int) elapsedS;

        String prefix = sessionTypeLabel() + " · " + fmtTime(displaySecs);
        String suffix;
        if ("reconnecting".equals(bleStatus) || "error".equals(bleStatus) || "permission_denied".equals(bleStatus)) {
            suffix = "banda desconectada — a reconectar…";
        } else if (bpm != null) {
            suffix = bpm + " bpm";
        } else {
            suffix = "a aguardar sinal…";
        }
        String body = prefix + " · " + suffix;

        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent contentIntent = PendingIntent.getActivity(context, NOTIFICATION_ID, launchIntent, flags);

        int iconResId = context.getResources().getIdentifier("ic_notification", "drawable", context.getPackageName());
        if (iconResId == 0) {
            iconResId = context.getApplicationInfo().icon;
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);

        Notification notification = builder
            .setContentTitle("Neroes HRV")
            .setContentText(body)
            .setSmallIcon(iconResId)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, notification);
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        Context context = getContext();
        if (context == null) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Gravação em curso", NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Notificação persistente enquanto uma sessão está a ser gravada");
        nm.createNotificationChannel(channel);
    }
}
