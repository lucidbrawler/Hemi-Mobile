# Hemi BTC

Unofficial demo wallet for **native Bitcoin** and **hemiBTC** on Hemi mainnet, with the native Bitcoin tunnel in the same screen. It follows the layout of the Warthog mobile wallet (dark cards, a balance hero, a bottom tab bar) and uses Hemi’s public palette: black, white, and orange `#FF4600`.

This is not a Hemi Labs product. The Hemi name and hemiBTC ticker are used so the demo is recognizable. The mark in the header is original.

## What it does

- Creates or imports a 12-word phrase. Bitcoin uses BIP84 (`m/84'/0'/0'/0/0`). Hemi uses the standard EVM path (`m/44'/60'/0'/0/0`) on chain id `43111`.
- Encrypts the phrase in the browser with a password (PBKDF2 + AES-GCM). The app does not upload keys.
- Shows a live Bitcoin balance from mempool.space and a live hemiBTC balance from `0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28` (8 decimals).
- Sends native BTC, or hemiBTC when the Hemi address has a little ETH for gas.
- Embeds the native tunnel:
  - **Deposit** pays the live vault (`bitcoinCustodyAddress` on vault index 8) and adds an OP_RETURN of the uppercase Hemi address, which is the memo the Hemi portal sends.
  - **Withdraw** calls `initiateWithdrawal` on the vault factory `0xEAcA824F46c000fB89403846Bb57e6b913321081`.
  - After enough Bitcoin confirmations, **Mint hemiBTC** calls `confirmDeposit` for a deposit this wallet broadcast.
- The official portal (`https://app.hemi.xyz/tunnel/`) sends `X-Frame-Options: SAMEORIGIN`, so it cannot be placed in an iframe. The tunnel screen talks to the same vault instead.

Mainnet coins move if you confirm a send or a tunnel. A new wallet starts at zero.

## Run it in the browser

```bash
cd webdev/hemi
npm install
npm run dev
```

Open http://127.0.0.1:5173 . Create a wallet, then use Wallet, Tunnel, and Activity.

```bash
npm run selfcheck
```

Checks the well-known “abandon …” phrase against the expected Bitcoin and Ethereum addresses, and checks that a tunnel memo is a 40-byte ASCII OP_RETURN.

## Demo APK

Android SDK and JDK 21 are required. Capacitor’s Android library is compiled as Java 21, so the system JDK 17 on this laptop will fail with `invalid source release: 21`. A portable Temurin 21 is already at `~/.local/jdks/jdk-21.0.12.1+1`. The debug APK is produced with Capacitor:

```bash
JAVA_HOME="$HOME/.local/jdks/jdk-21.0.12.1+1" npm run android:apk
cp android/app/build/outputs/apk/debug/app-debug.apk hemi-btc-demo.apk
```

`npm run android:apk` writes `android/app/build/outputs/apk/debug/app-debug.apk`. The sideload copy from this build is `hemi-btc-demo.apk` (gitignored). Debug builds are signed with the Android debug key and are for sideloading, not the Play Store.

## References

- Hemi tunnel: https://docs.hemi.xyz/how-to-tutorials/using-hemi/tunnel-from-bitcoin/tunnel-btc-to-hemi
- Hemi RPC: `https://rpc.hemi.network/rpc`
- Explorer: https://explorer.hemi.xyz
- Brand colors: https://hemi.xyz/brand-kit
