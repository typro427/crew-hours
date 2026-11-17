package com.deerfieldmanagement.billables;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Bill's Billables: the crew app's address-jobs screen (time in / out, chemicals, materials, receipts) on its own.
 * Everything Bill saves goes straight into Crew Hours, the same as the crew app.
 */
public class MainActivity extends Activity {
    static final String HOST = "mycrewhours.com";
    /** Fill in your crew link and Bill never has to type it, e.g. "https://mycrewhours.com/c/deerfield-water-system/". */
    static final String DEFAULT_LINK = "";

    static final int PICK_FILE = 41;
    static final int BG = Color.parseColor("#F3F2EE"), INK = Color.parseColor("#1F2328"), AMBER = Color.parseColor("#E3A008");

    private FrameLayout root;
    private WebView web;
    private View offline;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        // keep clear of the status bar, navigation bar and keyboard (Android 15 draws edge to edge)
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop(); r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
            getWindow().getInsetsController().setSystemBarsAppearance(
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }
        String link = link();
        if (link == null) showSetup(); else showWeb(link, saved);
    }

    /* ----------------------------- the crew link ----------------------------- */
    private SharedPreferences prefs() { return getSharedPreferences("billables", MODE_PRIVATE); }

    private String link() {
        String s = prefs().getString("link", null);
        if (s != null) return s;
        return DEFAULT_LINK.isEmpty() ? null : normalize(DEFAULT_LINK);
    }

    /** A full link, one without https://, or just the company's code -> https://mycrewhours.com/c/<code>/, or null. */
    static String normalize(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("/") && !s.contains(".")) s = "https://" + HOST + "/c/" + s + "/";
        if (!s.toLowerCase(Locale.US).startsWith("http")) s = "https://" + s;
        Uri u = Uri.parse(s);
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
        if (!h.equals(HOST) && !h.equals("www." + HOST)) return null;
        Matcher m = Pattern.compile("^/c/([a-z0-9-]{2,60})(/.*)?$").matcher(u.getPath() == null ? "" : u.getPath());
        return m.matches() ? "https://" + HOST + "/c/" + m.group(1) + "/" : null;
    }

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    private void showSetup() {
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        root.removeAllViews();
        ScrollView sv = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(48), dp(24), dp(24));
        sv.addView(col);

        TextView title = new TextView(this);
        title.setText("Bill's Billables");
        title.setTextColor(INK);
        title.setTextSize(30);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Enter the crew link from the boss. It looks like mycrewhours.com/c/your-company.");
        hint.setTextColor(Color.parseColor("#57606A"));
        hint.setTextSize(16);
        hint.setPadding(0, dp(10), 0, dp(18));
        col.addView(hint);

        EditText field = new EditText(this);
        field.setHint("mycrewhours.com/c/your-company");
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        field.setTextSize(17);
        col.addView(field, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView err = new TextView(this);
        err.setTextColor(Color.parseColor("#B42318"));
        err.setPadding(0, dp(8), 0, 0);
        col.addView(err);

        Button open = new Button(this);
        open.setText("Open");
        open.setAllCaps(false);
        open.setTextSize(17);
        open.setTextColor(INK);
        open.setBackgroundColor(AMBER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54));
        lp.topMargin = dp(14);
        col.addView(open, lp);

        Runnable go = () -> {
            String n = normalize(field.getText().toString());
            if (n == null) { err.setText("That isn't a crew link. It should look like mycrewhours.com/c/your-company."); return; }
            prefs().edit().putString("link", n).apply();
            root.removeAllViews();
            showWeb(n, null);
        };
        open.setOnClickListener(v -> go.run());
        field.setOnEditorActionListener((v, actionId, e) -> { go.run(); return true; });
        root.addView(sv);
        field.requestFocus();
    }

    /* ----------------------------- the crew app ----------------------------- */
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void showWeb(String link, Bundle saved) {
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " BillsBillablesApp/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "CrewHoursAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String h = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);
                if (("https".equals(u.getScheme()) || "http".equals(u.getScheme())) && h.endsWith(HOST)) return false;   // the crew site stays in the app
                openOutside(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) showOffline(true);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (offline != null && offline.getVisibility() == View.VISIBLE && !url.startsWith("data:")) showOffline(false);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return chooseFile(callback, params);
            }
        });

        // a download (an Excel or PDF): open it in the phone's browser, which can save it
        web.setDownloadListener((url, ua, disposition, mime, length) -> openOutside(Uri.parse(url)));

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (saved != null && web.restoreState(saved) != null) return;
        web.loadUrl(link + "?only=jobs");
    }

    private void showOffline(boolean show) {
        if (offline == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(BG);
            box.setPadding(dp(32), dp(32), dp(32), dp(32));
            TextView t = new TextView(this);
            t.setText("No connection");
            t.setTextColor(INK); t.setTextSize(24); t.setTypeface(Typeface.DEFAULT_BOLD); t.setGravity(Gravity.CENTER);
            TextView d = new TextView(this);
            d.setText("Bill's Billables needs signal the first time it opens. After that it works offline and sends your jobs when signal comes back.");
            d.setTextColor(Color.parseColor("#57606A")); d.setTextSize(16); d.setGravity(Gravity.CENTER); d.setPadding(0, dp(10), 0, dp(18));
            Button b = new Button(this);
            b.setText("Try again"); b.setAllCaps(false); b.setTextColor(INK); b.setBackgroundColor(AMBER);
            b.setOnClickListener(v -> { if (web != null) { String l = link(); if (l != null) web.loadUrl(l + "?only=jobs"); } });
            box.addView(t); box.addView(d); box.addView(b, new LinearLayout.LayoutParams(dp(200), dp(50)));
            offline = box;
            root.addView(offline, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        offline.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) offline.bringToFront();
    }

    private void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
    }

    /** "Different company? Change the crew link" on the PIN screen. */
    class Bridge {
        @JavascriptInterface
        public void setup() {
            runOnUiThread(() -> { prefs().edit().remove("link").apply(); offline = null; showSetup(); });
        }
    }

    /* ----------------------------- receipts: camera or gallery ----------------------------- */
    private boolean chooseFile(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        cameraUri = null;
        Intent pick;
        try { pick = params.createIntent(); } catch (Exception e) { pick = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE); }
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        ArrayList<Intent> extra = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 29) {   // a new photo, saved to Pictures/Bill's Billables
            try {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Images.Media.DISPLAY_NAME, "receipt-" + System.currentTimeMillis() + ".jpg");
                cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Bill's Billables");
                cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (cameraUri != null) {
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    if (cam.resolveActivity(getPackageManager()) != null) extra.add(cam);
                }
            } catch (Exception ignored) { cameraUri = null; }
        }
        Intent chooser = Intent.createChooser(pick, "Add a photo or receipt");
        if (!extra.isEmpty()) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toArray(new Intent[0]));
        try {
            startActivityForResult(chooser, PICK_FILE);
            return true;
        } catch (ActivityNotFoundException e) {
            fileCallback = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE) { super.onActivityResult(requestCode, resultCode, data); return; }
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                result = new Uri[]{ data.getData() };
            } else if (cameraUri != null) {
                result = new Uri[]{ cameraUri };       // took a photo
            }
        }
        if ((result == null || result[0] != cameraUri) && cameraUri != null) {   // didn't use the camera: remove the empty photo
            try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) { }
        }
        if (fileCallback != null) fileCallback.onReceiveValue(result);
        fileCallback = null;
        cameraUri = null;
    }

    /* ----------------------------- back button, saving state ----------------------------- */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) { web.goBack(); return true; }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
