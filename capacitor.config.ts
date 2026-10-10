import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.demo.hemibtcwallet",
  appName: "Hemi BTC",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // The Merkl API omits CORS headers. Native fetch reads it from the APK.
    CapacitorHttp: { enabled: true },
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
