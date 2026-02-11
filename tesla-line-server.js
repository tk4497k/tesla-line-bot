// ============================================================
// Tesla Model Y × LINE Bot サーバー
// ============================================================
// LINE Messaging API と Tesla Fleet API を連携するサーバー
//
// セットアップ:
//   1. npm init -y
//   2. npm install express @line/bot-sdk axios dotenv
//   3. .env ファイルに環境変数を設定
//   4. node tesla-line-server.js
// ============================================================
console.log("ENV CHECK:", process.env.TESLA_CLIENT_ID ? "CLIENT_ID OK" : "CLIENT_ID MISSING");
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const line = require("@line/bot-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── LINE 設定 ───────────────────────────────────
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ─── Tesla 設定 ──────────────────────────────────
let teslaTokens = {
  accessToken: process.env.TESLA_ACCESS_TOKEN,
  refreshToken: process.env.TESLA_REFRESH_TOKEN,
};
const TESLA_VEHICLE_ID = process.env.TESLA_VEHICLE_ID;
const TESLA_API_BASE =
  process.env.TESLA_API_BASE || "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;

// ─── Tesla API ヘルパー関数 ──────────────────────

// アクセストークンを自動リフレッシュ
async function refreshTeslaToken() {
  try {
    const res = await axios.post("https://auth.tesla.com/oauth2/v3/token", {
      grant_type: "refresh_token",
      client_id: TESLA_CLIENT_ID,
      client_secret: TESLA_CLIENT_SECRET,
      refresh_token: teslaTokens.refreshToken,
    });
    teslaTokens.accessToken = res.data.access_token;
    if (res.data.refresh_token) {
      teslaTokens.refreshToken = res.data.refresh_token;
    }
    console.log("Tesla token refreshed successfully");
    return true;
  } catch (err) {
    console.error("Token refresh failed:", err.response?.data || err.message);
    return false;
  }
}

// Tesla API リクエスト（自動リトライ付き）
async function teslaRequest(method, path, data = null) {
  const url = `${TESLA_API_BASE}/api/1/vehicles/${TESLA_VEHICLE_ID}${path}`;
  const config = {
    method,
    url,
    headers: { Authorization: `Bearer ${teslaTokens.accessToken}` },
  };
  if (data) config.data = data;

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    // 401 なら token refresh してリトライ
    if (err.response?.status === 401) {
      const refreshed = await refreshTeslaToken();
      if (refreshed) {
        config.headers.Authorization = `Bearer ${teslaTokens.accessToken}`;
        const res = await axios(config);
        return res.data;
      }
    }
    throw err;
  }
}

// 車両を起こす（asleep 対策）
async function wakeUpVehicle() {
  try {
    await teslaRequest("POST", "/wake_up");
    // 起きるまで少し待つ
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (err) {
    console.error("Wake up failed:", err.message);
  }
}

// 車両データ取得
async function getVehicleData() {
  try {
    const res = await teslaRequest("GET", "/vehicle_data");
    return res.response;
  } catch (err) {
    if (
      err.response?.status === 408 ||
      err.response?.data?.error?.includes("asleep")
    ) {
      await wakeUpVehicle();
      const res = await teslaRequest("GET", "/vehicle_data");
      return res.response;
    }
    throw err;
  }
}

// コマンド送信
async function sendCommand(command, body = {}) {
  try {
    return await teslaRequest("POST", `/command/${command}`, body);
  } catch (err) {
    if (
      err.response?.status === 408 ||
      err.response?.data?.error?.includes("asleep")
    ) {
      await wakeUpVehicle();
      return await teslaRequest("POST", `/command/${command}`, body);
    }
    throw err;
  }
}

// ─── メッセージ処理 ─────────────────────────────

async function handleMessage(userMessage) {
  const msg = userMessage.toLowerCase();

  try {
    // バッテリー・充電
    if (
      msg.includes("バッテリー") ||
      msg.includes("充電") ||
      msg.includes("電池") ||
      msg.includes("残量")
    ) {
      const data = await getVehicleData();
      const cs = data.charge_state;
      return [
        `🔋 バッテリー情報`,
        ``,
        `残量: ${cs.battery_level}%`,
        `航続距離: ${Math.round(cs.battery_range * 1.60934)} km`,
        `充電状態: ${cs.charging_state === "Disconnected" ? "未接続" : cs.charging_state === "Charging" ? "充電中" : cs.charging_state}`,
        `充電上限: ${cs.charge_limit_soc}%`,
        cs.time_to_full_charge > 0
          ? `満充電まで: 約${Math.round(cs.time_to_full_charge * 60)}分`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    }

    // エアコンON
    if (
      msg.includes("エアコンつけて") ||
      msg.includes("エアコンオン") ||
      msg.includes("暖めて") ||
      msg.includes("プレコン")
    ) {
      await sendCommand("auto_conditioning_start");
      return `✅ エアコンをONにしました！\n車内が快適になるまでお待ちください 🚗`;
    }

    // エアコンOFF
    if (
      msg.includes("エアコン消して") ||
      msg.includes("エアコンオフ") ||
      msg.includes("エアコン止めて")
    ) {
      await sendCommand("auto_conditioning_stop");
      return `✅ エアコンをOFFにしました。`;
    }

    // エアコン・温度情報
    if (
      msg.includes("エアコン") ||
      msg.includes("温度") ||
      msg.includes("空調")
    ) {
      const data = await getVehicleData();
      const cl = data.climate_state;
      return [
        `🌡️ 空調情報`,
        ``,
        `車内温度: ${cl.inside_temp}°C`,
        `外気温: ${cl.outside_temp}°C`,
        `エアコン: ${cl.is_climate_on ? "ON" : "OFF"}`,
        `設定温度: ${cl.driver_temp_setting}°C`,
      ].join("\n");
    }

    // 位置情報
    if (
      msg.includes("場所") ||
      msg.includes("位置") ||
      msg.includes("どこ") ||
      msg.includes("駐車")
    ) {
      const data = await getVehicleData();
      const ds = data.drive_state;
      return [
        `📍 現在位置`,
        ``,
        `https://maps.google.com/?q=${ds.latitude},${ds.longitude}`,
      ].join("\n");
    }

    // ロック解除
    if (
      msg.includes("ロック解除") ||
      msg.includes("アンロック") ||
      msg.includes("鍵開けて") ||
      msg.includes("開錠")
    ) {
      await sendCommand("door_unlock");
      return `🔓 ドアロックを解除しました！`;
    }

    // ロック（施錠）
    if (msg.includes("施錠") || msg.includes("ロックして")) {
      await sendCommand("door_lock");
      return `🔒 ドアをロックしました！`;
    }

    // ロック状態確認
    if (msg.includes("ロック") || msg.includes("鍵")) {
      const data = await getVehicleData();
      const vs = data.vehicle_state;
      return [
        `🔒 ロック状態`,
        ``,
        `ドア: ${vs.locked ? "施錠済み ✅" : "解錠中 ⚠️"}`,
        `セントリーモード: ${vs.sentry_mode ? "ON" : "OFF"}`,
      ].join("\n");
    }

    // トランク
    if (msg.includes("トランク") && msg.includes("開")) {
      await sendCommand("actuate_trunk", { which_trunk: "rear" });
      return `✅ リアトランクを開けました！ 📦`;
    }

    // フランク
    if (msg.includes("フランク") && msg.includes("開")) {
      await sendCommand("actuate_trunk", { which_trunk: "front" });
      return `✅ フランク（前トランク）を開けました！`;
    }

    // クラクション
    if (msg.includes("クラクション") || msg.includes("ホーン")) {
      await sendCommand("honk_horn");
      return `📢 クラクションを鳴らしました！`;
    }

    // ライトフラッシュ
    if (msg.includes("フラッシュ") || msg.includes("ライト")) {
      await sendCommand("flash_lights");
      return `💡 ヘッドライトをフラッシュしました！ ✨`;
    }

    // セントリーモード
    if (msg.includes("セントリー") || msg.includes("監視")) {
      const data = await getVehicleData();
      return `👁️ セントリーモード: ${data.vehicle_state.sentry_mode ? "有効 ✅" : "無効"}`;
    }

    // 走行距離
    if (
      msg.includes("走行距離") ||
      msg.includes("オドメーター") ||
      msg.includes("距離")
    ) {
      const data = await getVehicleData();
      const km = Math.round(data.vehicle_state.odometer * 1.60934);
      return [
        `🛣️ 走行情報`,
        ``,
        `総走行距離: ${km.toLocaleString()} km`,
        `ソフトウェア: ${data.vehicle_state.car_version}`,
      ].join("\n");
    }

    // ステータス全体
    if (
      msg.includes("状態") ||
      msg.includes("ステータス") ||
      msg.includes("調子") ||
      msg.includes("元気")
    ) {
      const data = await getVehicleData();
      const cs = data.charge_state;
      const cl = data.climate_state;
      const vs = data.vehicle_state;
      const km = Math.round(vs.odometer * 1.60934);
      return [
        `🚗 ${data.display_name || "Model Y"} の状態`,
        ``,
        `🔋 バッテリー: ${cs.battery_level}% (${Math.round(cs.battery_range * 1.60934)}km)`,
        `🌡️ 車内: ${cl.inside_temp}°C / 外: ${cl.outside_temp}°C`,
        `❄️ エアコン: ${cl.is_climate_on ? "ON" : "OFF"}`,
        `🔒 ロック: ${vs.locked ? "施錠済み" : "解錠中"}`,
        `👁️ セントリー: ${vs.sentry_mode ? "ON" : "OFF"}`,
        `🛣️ 走行距離: ${km.toLocaleString()} km`,
        `📡 ソフトウェア: ${vs.car_version}`,
      ].join("\n");
    }

    // ヘルプ
    if (
      msg.includes("ヘルプ") ||
      msg.includes("使い方") ||
      msg.includes("何ができる") ||
      msg.includes("コマンド")
    ) {
      return [
        `💬 使えるコマンド`,
        ``,
        `🔋「バッテリー」→ 残量確認`,
        `🌡️「エアコン」→ 温度確認`,
        `❄️「エアコンつけて」→ エアコンON`,
        `📍「どこ？」→ 位置情報`,
        `🔒「ロック」→ 施錠状態確認`,
        `🔓「ロック解除」→ 解錠`,
        `🔐「施錠して」→ ロック`,
        `🚗「ステータス」→ 全体状態`,
        `📦「トランク開けて」→ 開閉`,
        `📢「クラクション」→ ホーン`,
        `💡「フラッシュ」→ ライト`,
        `👁️「セントリー」→ 監視状態`,
      ].join("\n");
    }

    // デフォルト
    return `すみません、よくわかりませんでした 🤔\n「ヘルプ」と送ると使えるコマンド一覧を表示します！`;
  } catch (err) {
    console.error("Error handling message:", err.response?.data || err.message);
    return `⚠️ エラーが発生しました\n\n${err.response?.data?.error || err.message}\n\nしばらく待ってから再度お試しください。`;
  }
}

// ─── Webhook エンドポイント ──────────────────────

// LINE Webhook 署名検証ミドルウェア
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // 署名検証
    const signature = req.headers["x-line-signature"];
    const body = req.body;

    const hash = crypto
      .createHmac("SHA256", lineConfig.channelSecret)
      .update(body)
      .digest("base64");

    if (hash !== signature) {
      console.error("Invalid signature");
      return res.status(403).json({ error: "Invalid signature" });
    }

    const parsedBody = JSON.parse(body.toString());

    // 即座に200を返す（LINE Platformのタイムアウト対策）
    res.status(200).json({ status: "ok" });

    // イベント処理
    for (const event of parsedBody.events) {
      if (event.type === "message" && event.message.type === "text") {
        const replyText = await handleMessage(event.message.text);

        try {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: replyText }],
          });
        } catch (err) {
          console.error("LINE reply error:", err.message);
        }
      }
    }
  }
);

// ─── Tesla OAuth コールバック ────────────────────

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send("Authorization code not found");
  }

  try {
    const tokenRes = await axios.post(
      "https://auth.tesla.com/oauth2/v3/token",
      {
        grant_type: "authorization_code",
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET,
        code,
        redirect_uri: `https://${req.get("host")}/auth/callback`,
      }
    );

    teslaTokens.accessToken = tokenRes.data.access_token;
    teslaTokens.refreshToken = tokenRes.data.refresh_token;

    // 車両一覧を取得
    const vehiclesRes = await axios.get(
      `${TESLA_API_BASE}/api/1/vehicles`,
      {
        headers: {
          Authorization: `Bearer ${teslaTokens.accessToken}`,
        },
      }
    );

    res.send(`
      <h1>✅ Tesla 認証成功！</h1>
      <h2>トークン情報（.envに保存してください）</h2>
      <pre>
TESLA_ACCESS_TOKEN=${teslaTokens.accessToken}
TESLA_REFRESH_TOKEN=${teslaTokens.refreshToken}
      </pre>
      <h2>車両一覧</h2>
      <pre>${JSON.stringify(vehiclesRes.data, null, 2)}</pre>
      <p>vehicle_id を .env の TESLA_VEHICLE_ID に設定してください。</p>
    `);
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send(`認証エラー: ${err.message}`);
  }
});

// ─── 公開鍵ホスティング ─────────────────────────

const fs = require("fs");
const path = require("path");

app.get(
  "/.well-known/appspecific/com.tesla.3p.public-key.pem",
  (req, res) => {
    const keyPath = path.join(__dirname, "public_key.pem");
    if (fs.existsSync(keyPath)) {
      res.type("application/x-pem-file").sendFile(keyPath);
    } else {
      res.status(404).send("Public key not found");
    }
  }
);

// ─── ヘルスチェック ─────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Tesla × LINE Bot",
    vehicle_id: TESLA_VEHICLE_ID ? "configured" : "not set",
  });
});

// ─── サーバー起動 ───────────────────────────────

app.listen(PORT, () => {
  console.log(`🚗 Tesla × LINE Bot server running on port ${PORT}`);
  console.log(`   Webhook URL: https://your-domain.com/webhook`);
  console.log(
    `   Tesla Vehicle ID: ${TESLA_VEHICLE_ID || "NOT SET - run OAuth first"}`
  );
});
