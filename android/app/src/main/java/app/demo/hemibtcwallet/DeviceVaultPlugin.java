package app.demo.hemibtcwallet;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Map;

/**
 * Phone vault for wallet envelopes. Values are encrypted with a keystore
 * master key (EncryptedSharedPreferences). Reading them does not ask for a
 * fingerprint. The password or the passkey key is the secret, matching the
 * Warthog wallet's SecureStore envelope.
 */
@CapacitorPlugin(name = "DeviceVault")
public class DeviceVaultPlugin extends Plugin {
    private static final String PREFS = "hemi_wallet_vault";
    private SharedPreferences vault;

    @PluginMethod
    public void list(PluginCall call) {
        try {
            JSArray rows = new JSArray();
            for (Map.Entry<String, ?> entry : vault().getAll().entrySet()) {
                Object value = entry.getValue();
                if (!(value instanceof String)) continue;
                JSObject row = new JSObject();
                row.put("key", entry.getKey());
                row.put("value", value);
                rows.put(row);
            }
            JSObject ret = new JSObject();
            ret.put("entries", rows);
            call.resolve(ret);
        } catch (Exception err) {
            call.reject(err.getMessage() == null ? "Could not read the wallet vault." : err.getMessage());
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.isEmpty() || value == null) {
            call.reject("Missing vault entry.");
            return;
        }
        try {
            if (!vault().edit().putString(key, value).commit()) {
                call.reject("Could not save the wallet vault.");
                return;
            }
            call.resolve();
        } catch (Exception err) {
            call.reject(err.getMessage() == null ? "Could not save the wallet vault." : err.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        JSObject ret = new JSObject();
        ret.put("ok", true);
        if (key == null || key.isEmpty()) {
            call.resolve(ret);
            return;
        }
        try {
            vault().edit().remove(key).commit();
        } catch (Exception ignored) {
            // The JavaScript cache is already updated.
        }
        call.resolve(ret);
    }

    private SharedPreferences vault() throws Exception {
        if (vault != null) return vault;
        Context context = getContext();
        String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
        vault = EncryptedSharedPreferences.create(
            PREFS,
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
        return vault;
    }
}
