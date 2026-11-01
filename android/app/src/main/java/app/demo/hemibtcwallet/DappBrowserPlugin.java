package app.demo.hemibtcwallet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * In-app browser. The page gets an EIP-1193 provider. Requests come back to
 * the wallet, which approves them. The page cannot choose the origin we show.
 */
@CapacitorPlugin(name = "DappBrowser")
public class DappBrowserPlugin extends Plugin {
    private View overlay;
    private WebView webView;
    private EditText urlField;
    private ProgressBar progress;
    private String providerScript;
    private OnBackPressedCallback back;

    @PluginMethod
    public void open(PluginCall call) {
        String url = httpsUrl(call.getString("url"));
        if (url == null) {
            call.reject("Open an https site.");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("The browser is closed.");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                ensure();
                webView.loadUrl(url);
                overlay.setVisibility(View.VISIBLE);
                call.resolve();
            } catch (Exception err) {
                tearDown();
                call.reject(err.getMessage() == null ? "Could not open the browser." : err.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            tearDown();
            call.resolve();
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", true));
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            if (overlay != null) {
                overlay.setVisibility(visible ? View.VISIBLE : View.GONE);
                if (!visible) hideKeyboard();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void respond(PluginCall call) {
        Integer id = call.getInt("id");
        String payload = call.getString("payload", "null");
        if (id == null || payload == null) {
            call.reject("Missing result.");
            return;
        }
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok", false));
        runJs("window.__hemiResolve(" + id + "," + (ok ? "true" : "false") + "," + jsValue(payload) + ")");
        call.resolve();
    }

    @PluginMethod
    public void emit(PluginCall call) {
        String event = call.getString("event", "");
        String payload = call.getString("payload", "null");
        if (!"accountsChanged".equals(event) && !"chainChanged".equals(event)) {
            call.reject("Unknown event.");
            return;
        }
        if (payload == null) payload = "null";
        runJs("window.__hemiEmit(" + JSONObject.quote(event) + "," + jsValue(payload) + ")");
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        Activity activity = getActivity();
        if (activity == null) {
            overlay = null;
            webView = null;
            return;
        }
        activity.runOnUiThread(this::tearDown);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void ensure() throws IOException {
        if (overlay != null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            throw new IOException("Update Android System WebView, then open the site again.");
        }
        String script = provider();
        if (script.isEmpty()) throw new IOException("The site connection script is missing.");
        Activity activity = getActivity();
        if (activity == null) throw new IOException("The browser is closed.");
        overlay = LayoutInflater.from(activity).inflate(R.layout.dapp_browser, null);
        overlay.setBackgroundColor(0xFF09090B);
        urlField = overlay.findViewById(R.id.dapp_url);
        progress = overlay.findViewById(R.id.dapp_progress);
        webView = overlay.findViewById(R.id.dapp_web);
        Button backButton = overlay.findViewById(R.id.dapp_back);
        Button go = overlay.findViewById(R.id.dapp_go);
        Button close = overlay.findViewById(R.id.dapp_close);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        String agent = settings.getUserAgentString();
        if (agent != null) settings.setUserAgentString(agent.replace("; wv", ""));
        webView.setBackgroundColor(0xFF09090B);
        WebViewCompat.addWebMessageListener(webView, "HemiDapp", Collections.singleton("*"),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> onPageMessage(view, message, sourceOrigin, isMainFrame));
        WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton("*"));
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (url != null && !url.equals("about:blank") && !isHttps(url)) {
                    view.stopLoading();
                    return;
                }
                if (url != null && url.startsWith("https://")) view.evaluateJavascript(provider(), null);
                if (progress != null) progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (urlField != null && !urlField.hasFocus() && url != null) urlField.setText(url);
                if (progress != null) progress.setVisibility(View.GONE);
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isHttps(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isHttps(request.getUrl().toString());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progress == null) return;
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }
        });
        backButton.setOnClickListener(view -> {
            if (webView.canGoBack()) webView.goBack();
            else tearDown();
        });
        go.setOnClickListener(view -> loadTyped());
        close.setOnClickListener(view -> tearDown());
        urlField.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                loadTyped();
                return true;
            }
            return false;
        });
        activity.addContentView(overlay, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        ComponentActivity host = componentActivity();
        if (back == null && host != null) {
            back = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (overlay == null || overlay.getVisibility() != View.VISIBLE) {
                        setEnabled(false);
                        ComponentActivity current = componentActivity();
                        if (current != null) current.getOnBackPressedDispatcher().onBackPressed();
                        setEnabled(true);
                        return;
                    }
                    if (webView != null && webView.canGoBack()) webView.goBack();
                    else tearDown();
                }
            };
            host.getOnBackPressedDispatcher().addCallback(host, back);
        }
    }

    private ComponentActivity componentActivity() {
        Activity activity = getActivity();
        if (activity instanceof ComponentActivity) return (ComponentActivity) activity;
        return null;
    }

    private void loadTyped() {
        String url = httpsUrl(urlField == null ? null : urlField.getText().toString());
        if (url == null || webView == null) return;
        urlField.setText(url);
        webView.loadUrl(url);
        hideKeyboard();
    }

    private void onPageMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame) {
        if (!isMainFrame || message == null) return;
        String data = message.getData();
        if (data == null) return;
        String origin = originOf(sourceOrigin);
        String page = originOf(view.getUrl());
        if (origin.isEmpty() || !origin.equals(page)) return;
        deliver(data, origin);
    }

    private void deliver(String raw, String origin) {
        try {
            JSONObject obj = new JSONObject(raw);
            JSObject event = new JSObject();
            event.put("id", obj.optInt("id"));
            event.put("origin", origin);
            event.put("method", obj.optString("method", ""));
            JSONArray params = obj.optJSONArray("params");
            event.put("params", params == null ? "[]" : params.toString());
            notifyListeners("request", event);
        } catch (Exception ignored) {
            // A malformed page message is dropped.
        }
    }

    /** Embed a JSON value in evaluateJavascript without breaking the script. */
    private static String jsValue(String json) {
        String quoted = JSONObject.quote(json == null ? "null" : json);
        return "JSON.parse(" + quoted.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ")";
    }

    private void runJs(String source) {
        Activity activity = getActivity();
        if (activity == null || webView == null) return;
        activity.runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(source, null);
        });
    }

    private void hideKeyboard() {
        Activity activity = getActivity();
        if (activity == null || overlay == null) return;
        InputMethodManager manager = (InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
        if (manager != null) manager.hideSoftInputFromWindow(overlay.getWindowToken(), 0);
    }

    private void tearDown() {
        if (overlay != null) {
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) parent.removeView(overlay);
            overlay = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        urlField = null;
        progress = null;
        notifyListeners("closed", new JSObject());
    }

    private String provider() {
        if (providerScript != null) return providerScript;
        try (InputStream in = getContext().getResources().openRawResource(R.raw.hemi_provider)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int read;
            while ((read = in.read(buf)) >= 0) out.write(buf, 0, read);
            providerScript = out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception err) {
            return "";
        }
        return providerScript;
    }

    private static boolean isHttps(String url) {
        if (url == null) return false;
        String scheme = Uri.parse(url).getScheme();
        return scheme != null && scheme.equalsIgnoreCase("https");
    }

    private static String httpsUrl(String input) {
        if (input == null) return null;
        String text = input.trim();
        if (text.isEmpty()) return null;
        if (!text.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) text = "https://" + text;
        Uri uri = Uri.parse(text);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || uri.getUserInfo() != null) return null;
        if (!scheme.equalsIgnoreCase("https") || !host.contains(".")) return null;
        return uri.toString();
    }

    private static String originOf(String url) {
        if (url == null) return "";
        return originOf(Uri.parse(url));
    }

    private static String originOf(Uri uri) {
        if (uri == null) return "";
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return "";
        scheme = scheme.toLowerCase(Locale.US);
        host = host.toLowerCase(Locale.US);
        int port = uri.getPort();
        boolean standard = port < 0
            || ("https".equals(scheme) && port == 443)
            || ("http".equals(scheme) && port == 80);
        if (standard) return scheme + "://" + host;
        return scheme + "://" + host + ":" + port;
    }
}
