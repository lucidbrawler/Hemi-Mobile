package app.demo.hemibtcwallet;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Phone passkey: the system fingerprint, face, or PIN prompt, then an
 * Android Keystore key that never leaves this app.
 */
@CapacitorPlugin(name = "DevicePasskey")
public class DevicePasskeyPlugin extends Plugin {
    private static final String STORE = "AndroidKeyStore";

    @PluginMethod
    public void canAuthenticate(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(authenticators());
        JSObject ret = new JSObject();
        ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void protect(PluginCall call) {
        String name = call.getString("name");
        String plaintext = call.getString("plaintext");
        if (name == null || name.trim().isEmpty() || plaintext == null) {
            call.reject("Missing wallet.");
            return;
        }
        String alias = aliasFor(name);
        authenticate(call, "Save " + name.trim(), "Confirm to keep this wallet on this phone", () -> {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreate(alias));
                byte[] sealed = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                JSObject ret = new JSObject();
                ret.put("alias", alias);
                ret.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
                ret.put("ciphertext", Base64.encodeToString(sealed, Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception err) {
                call.reject(err.getMessage() == null ? "Could not save the passkey." : err.getMessage());
            }
        });
    }

    @PluginMethod
    public void reveal(PluginCall call) {
        String alias = call.getString("alias");
        String iv = call.getString("iv");
        String ciphertext = call.getString("ciphertext");
        if (alias == null || iv == null || ciphertext == null) {
            call.reject("This wallet has no passkey.");
            return;
        }
        authenticate(call, "Unlock Hemi BTC", "Confirm the passkey on this phone", () -> {
            try {
                SecretKey key = existing(alias);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    key,
                    new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))
                );
                byte[] plain = cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP));
                JSObject ret = new JSObject();
                ret.put("plaintext", new String(plain, StandardCharsets.UTF_8));
                call.resolve(ret);
            } catch (Exception err) {
                call.reject("Passkey unlock failed.");
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String alias = call.getString("alias");
        JSObject ret = new JSObject();
        ret.put("ok", true);
        if (alias == null || alias.isEmpty()) {
            call.resolve(ret);
            return;
        }
        try {
            KeyStore ks = KeyStore.getInstance(STORE);
            ks.load(null);
            ks.deleteEntry(alias);
        } catch (Exception ignored) {
            // The wallet record is still removed on the JavaScript side.
        }
        call.resolve(ret);
    }

    private void authenticate(PluginCall call, String title, String subtitle, Runnable after) {
        if (!(getActivity() instanceof FragmentActivity)) {
            call.reject("Passkey needs the app screen.");
            return;
        }
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    after.run();
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    String message = errString == null ? "Passkey cancelled." : errString.toString();
                    call.reject(message);
                }
            };
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                callback
            );
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(authenticators());
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                info.setNegativeButtonText("Cancel");
            }
            prompt.authenticate(info.build());
        });
    }

    private int authenticators() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.Authenticators.BIOMETRIC_STRONG
                | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        return BiometricManager.Authenticators.BIOMETRIC_WEAK;
    }

    private SecretKey getOrCreate(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        if (ks.containsAlias(alias)) {
            return existing(alias);
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        gen.init(
            new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return gen.generateKey();
    }

    private SecretKey existing(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        java.security.Key key = ks.getKey(alias, null);
        if (!(key instanceof SecretKey)) throw new IllegalStateException("Passkey for this wallet is missing.");
        return (SecretKey) key;
    }

    private String aliasFor(String name) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(name.trim().getBytes(StandardCharsets.UTF_8));
            StringBuilder alias = new StringBuilder("hemi");
            for (int i = 0; i < 16; i++) alias.append(String.format("%02x", hashed[i]));
            return alias.toString();
        } catch (Exception err) {
            throw new IllegalStateException("Could not name the passkey.");
        }
    }
}
