package app.demo.hemibtcwallet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DevicePasskeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
