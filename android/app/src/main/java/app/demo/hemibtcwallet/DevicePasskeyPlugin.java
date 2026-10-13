package app.demo.hemibtcwallet;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
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
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Phone passkey. The AES key stays in the Android Keystore and never enters
 * JavaScript. Each read asks for a fingerprint or face. A device PIN is not
 * accepted. Enrolling another fingerprint does not delete the key. A key from
 * an older build still opens with a fingerprint or face, then the phrase is
 * wrapped again under a new key when that succeeds.
 */
@CapacitorPlugin(name = "DevicePasskey")
public class DevicePasskeyPlugin extends Plugin {
    private static final String STORE = "AndroidKeyStore";

    private interface CipherWork {
        void run(Cipher cipher) throws Exception;
    }

    private interface FailWork {
        void run(String message);
    }

    @PluginMethod
    public void canAuthenticate(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", unlockAvailable());
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
        try {
            String alias = aliasForSave(name);
            SecretKey key = keyFor(alias);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            runBiometric(
                call,
                "Save " + name.trim(),
                "Confirm with your fingerprint or face",
                cipher,
                (unlocked) -> {
                    byte[] sealed = unlocked.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                    dropLegacyAlias(aliasFor(name), alias);
                    JSObject ret = new JSObject();
                    ret.put("alias", alias);
                    ret.put("iv", Base64.encodeToString(unlocked.getIV(), Base64.NO_WRAP));
                    ret.put("ciphertext", Base64.encodeToString(sealed, Base64.NO_WRAP));
                    call.resolve(ret);
                },
                (message) -> call.reject(message)
            );
        } catch (Exception err) {
            call.reject(err.getMessage() == null ? "Could not save the passkey." : err.getMessage());
        }
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
        try {
            SecretKey key = existing(alias);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                key,
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))
            );
            byte[] sealed = Base64.decode(ciphertext, Base64.NO_WRAP);
            boolean authRequired = userAuthRequired(key);
            runBiometric(
                call,
                "Unlock Hemi BTC",
                "Confirm with your fingerprint or face",
                authRequired ? cipher : null,
                (unlocked) -> {
                    byte[] plain = (authRequired ? unlocked : cipher).doFinal(sealed);
                    JSObject ret = new JSObject();
                    if (needsBiometricUpgrade(key)) wrapUnderBiometric(call, ret, plain, alias);
                    else finish(call, ret, plain);
                },
                (message) -> call.reject(message)
            );
        } catch (Exception err) {
            call.reject("Passkey unlock failed.");
        }
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

    /**
     * Fingerprint or face only. When {@code cipher} is set, the prompt unlocks
     * that keystore operation. A null cipher is the check used before reading a
     * legacy key that does not require auth.
     */
    private void runBiometric(
        PluginCall call,
        String title,
        String subtitle,
        Cipher cipher,
        CipherWork work,
        FailWork onFailure
    ) {
        if (!(getActivity() instanceof FragmentActivity)) {
            onFailure.run("Passkey needs the app screen.");
            return;
        }
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            if (activity.getWindow() == null) {
                onFailure.run("Passkey needs the app screen.");
                return;
            }
            activity.getWindow().getDecorView().post(() -> {
            BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    try {
                        Cipher unlocked = cipher;
                        if (
                            cipher != null
                            && result.getCryptoObject() != null
                            && result.getCryptoObject().getCipher() != null
                        ) {
                            unlocked = result.getCryptoObject().getCipher();
                        }
                        work.run(unlocked);
                    } catch (Exception err) {
                        call.reject(err.getMessage() == null ? "Passkey unlock failed." : err.getMessage());
                    }
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    onFailure.run(errString == null ? "Passkey cancelled." : errString.toString());
                }
            };
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                callback
            );
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
            }
            info.setNegativeButtonText("Cancel");
            if (cipher != null) prompt.authenticate(info.build(), new BiometricPrompt.CryptoObject(cipher));
            else prompt.authenticate(info.build());
            });
        });
    }

    private boolean unlockAvailable() {
        BiometricManager manager = BiometricManager.from(getContext());
        int kind = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG
            : BiometricManager.Authenticators.BIOMETRIC_WEAK;
        return manager.canAuthenticate(kind) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    /** Second fingerprint or face, then the phrase lives under a biometric-only key. */
    private void wrapUnderBiometric(PluginCall call, JSObject ret, byte[] plain, String currentAlias) {
        try {
            String nextAlias = nextAlias(currentAlias);
            SecretKey next = keyFor(nextAlias);
            if (needsBiometricUpgrade(next)) {
                finish(call, ret, plain);
                return;
            }
            Cipher enc = Cipher.getInstance("AES/GCM/NoPadding");
            enc.init(Cipher.ENCRYPT_MODE, next);
            runBiometric(
                call,
                "Update passkey",
                "Confirm your fingerprint or face once more",
                enc,
                (unlocked) -> {
                    try {
                        byte[] resealed = unlocked.doFinal(plain);
                        ret.put("upgradedAlias", nextAlias);
                        ret.put("upgradedIv", Base64.encodeToString(unlocked.getIV(), Base64.NO_WRAP));
                        ret.put("upgradedCiphertext", Base64.encodeToString(resealed, Base64.NO_WRAP));
                    } catch (Exception ignored) {
                        // The current key still opens. The next unlock tries again.
                    }
                    finish(call, ret, plain);
                },
                (message) -> finish(call, ret, plain)
            );
        } catch (Exception err) {
            finish(call, ret, plain);
        }
    }

    private void finish(PluginCall call, JSObject ret, byte[] plain) {
        try {
            ret.put("plaintext", new String(plain, StandardCharsets.UTF_8));
            call.resolve(ret);
        } finally {
            java.util.Arrays.fill(plain, (byte) 0);
        }
    }

    /** Prefer the name alias. A weaker key stays until the new key has encrypted the phrase. */
    private String aliasForSave(String name) throws Exception {
        return openAlias(aliasFor(name));
    }

    private String nextAlias(String currentAlias) throws Exception {
        return openAlias(currentAlias + "a");
    }

    /** First alias in the chain that is free, or already biometric-only. Never deletes a key. */
    private String openAlias(String start) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        String alias = start;
        for (int i = 0; i < 4; i++) {
            if (!ks.containsAlias(alias)) return alias;
            if (!needsBiometricUpgrade(existing(alias))) return alias;
            alias = alias + "a";
        }
        throw new IllegalStateException("Could not save the passkey.");
    }

    private SecretKey keyFor(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        if (ks.containsAlias(alias)) return existing(alias);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            builder.setInvalidatedByBiometricEnrollment(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            builder.setUserAuthenticationValidityDurationSeconds(-1);
        }
        gen.init(builder.build());
        return gen.generateKey();
    }

    private boolean needsBiometricUpgrade(SecretKey key) {
        try {
            KeyInfo info = keyInfo(key);
            if (!info.isUserAuthenticationRequired()) return true;
            if (info.getUserAuthenticationValidityDurationSeconds() > 0) return true;
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && (info.getUserAuthenticationType() & KeyProperties.AUTH_DEVICE_CREDENTIAL) != 0
            ) {
                return true;
            }
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && info.isInvalidatedByBiometricEnrollment();
        } catch (Exception err) {
            return false;
        }
    }

    private void dropLegacyAlias(String primary, String used) {
        if (primary.equals(used)) return;
        try {
            KeyStore ks = KeyStore.getInstance(STORE);
            ks.load(null);
            if (ks.containsAlias(primary)) ks.deleteEntry(primary);
        } catch (Exception ignored) {
            // The new key is already in the envelope. The old one can be removed later.
        }
    }

    private boolean userAuthRequired(SecretKey key) {
        try {
            return keyInfo(key).isUserAuthenticationRequired();
        } catch (Exception err) {
            return false;
        }
    }

    private KeyInfo keyInfo(SecretKey key) throws Exception {
        SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), STORE);
        return (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
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
