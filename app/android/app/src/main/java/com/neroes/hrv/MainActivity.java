package com.neroes.hrv;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (non-npm) plugin — must be registered before super.onCreate().
        registerPlugin(NotificationTickerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
