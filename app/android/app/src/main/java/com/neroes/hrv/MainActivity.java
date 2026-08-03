package com.neroes.hrv;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "NeroesMain";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Earlier builds of this app shipped a PWA service worker. Its
        // registration + Cache Storage live in the WebView's data dir inside
        // app data, which SURVIVES an APK update installed over the top — so
        // the old worker kept intercepting https://localhost and serving the
        // OLD precached JS bundle no matter how fresh the APK was (and its
        // NetworkFirst rule with no timeout also froze login). A JS-side
        // purge can't fully fix that: if the old worker serves old JS, the
        // new purge code never runs. Deleting the WebView's Service Worker
        // storage here — before super.onCreate() starts the WebView — kills
        // it for good. Auth/session data are untouched (SharedPreferences),
        // as are recorded sessions (databases/). Native builds no longer
        // ship any service worker, so after one run this is a no-op.
        nukeWebViewServiceWorker();

        // Local (non-npm) plugin — must be registered before super.onCreate().
        registerPlugin(NotificationTickerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private void nukeWebViewServiceWorker() {
        try {
            File dataDir = getApplicationContext().getDataDir();
            // Chromium WebView layouts seen in the wild — cover both.
            String[] targets = {
                "app_webview/Default/Service Worker",
                "app_webview/Service Worker",
            };
            for (String rel : targets) {
                File dir = new File(dataDir, rel);
                if (dir.exists()) {
                    boolean ok = deleteRecursively(dir);
                    Log.i(TAG, "service worker storage '" + rel + "' deleted=" + ok);
                }
            }
        } catch (Exception e) {
            // Never block startup over cleanup — worst case the JS-side
            // purge (purgeServiceWorker.js) still gets its chance.
            Log.w(TAG, "service worker cleanup failed", e);
        }
    }

    private boolean deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursively(c);
        }
        return f.delete();
    }
}
