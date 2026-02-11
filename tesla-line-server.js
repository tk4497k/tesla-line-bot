require("dotenv").config();
var express = require("express");
var crypto = require("crypto");
var axios = require("axios");
var line = require("@line/bot-sdk");
var fs = require("fs");
var path = require("path");

var app = express();
var PORT = process.env.PORT || 3000;

console.log("ENV CHECK:", process.env.TESLA_CLIENT_ID ? "CLIENT_ID OK" : "CLIENT_ID MISSING");
console.log("ENV CHECK:", process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_KEY OK" : "ANTHROPIC_KEY MISSING");

// --- LINE ---
var lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
var lineClient = null;
if (lineConfig.channelAccessToken) {
  lineClient = new line.messagingApi.MessagingApiClient({
    channelAccessToken: lineConfig.channelAccessToken,
  });
}

// --- Tesla ---
var teslaTokens = {
  accessToken: process.env.TESLA_ACCESS_TOKEN,
  refreshToken: process.env.TESLA_REFRESH_TOKEN,
};
var TESLA_VEHICLE_ID = process.env.TESLA_VEHICLE_ID;
var TESLA_API_BASE = process.env.TESLA_API_BASE || "https://fleet-api.prd.na.vn.cloud.tesla.com";
var TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
var TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;

// --- Claude ---
var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- 会話履歴 ---
var conversationHistory = {};
var MAX_HISTORY = 20;

// === Tesla API ヘルパー ===

async function refreshTeslaToken() {
  try {
    var res = await axios.post("https://auth.tesla.com/oauth2/v3/token", {
      grant_type: "refresh_token",
      client_id: TESLA_CLIENT_ID,
      client_secret: TESLA_CLIENT_SECRET,
      refresh_token: teslaTokens.refreshToken,
    });
    teslaTokens.accessToken = res.data.access_token;
    if (res.data.refresh_token) teslaTokens.refreshToken = res.data.refresh_token;
    console.log("Tesla token refreshed");
    return true;
  } catch (err) {
    console.error("Token refresh failed:", err.response ? err.response.data : err.message);
    return false;
  }
}

async function teslaRequest(method, urlPath, data) {
  var url = TESLA_API_BASE + "/api/1/vehicles/" + TESLA_VEHICLE_ID + urlPath;
  var config = {
    method: method,
    url: url,
    headers: { Authorization: "Bearer " + teslaTokens.accessToken },
  };
  if (data) config.data = data;
  try {
    var res = await axios(config);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      var ok = await refreshTeslaToken();
      if (ok) {
        config.headers.Authorization = "Bearer " + teslaTokens.accessToken;
        var res2 = await axios(config);
        return res2.data;
      }
    }
    throw err;
  }
}

async function wakeUpVehicle() {
  try {
    await teslaRequest("POST", "/wake_up");
    await new Promise(function (r) { setTimeout(r, 5000); });
    return true;
  } catch (err) {
    console.error("Wake up failed:", err.message);
    return false;
  }
}

async function getVehicleData() {
  try {
    var res = await teslaRequest("GET", "/vehicle_data");
    return res.response;
  } catch (err) {
    if (err.response && err.response.status === 408) {
      await wakeUpVehicle();
      var res2 = await teslaRequest("GET", "/vehicle_data");
      return res2.response;
    }
    throw err;
  }
}

async function sendCommand(command, body) {
  try {
    return await teslaRequest("POST", "/command/" + command, body || {});
  } catch (err) {
    if (err.response && err.response.status === 408) {
      await wakeUpVehicle();
      return await teslaRequest("POST", "/command/" + command, body || {});
    }
    throw err;
  }
}

// === 車両データをLLM用に整形 ===

function formatVehicleDataForLLM(data) {
  try {
    var cs = data.charge_state || {};
    var cl = data.climate_state || {};
    var ds = data.drive_state || {};
    var vs = data.vehicle_state || {};
    return JSON.stringify({
      name: data.display_name || "Model Y",
      battery_percent: cs.battery_level,
      range_km: Math.round((cs.battery_range || 0) * 1.60934),
      charging: cs.charging_state,
      charge_limit: cs.charge_limit_soc,
      inside_temp: cl.inside_temp,
      outside_temp: cl.outside_temp,
      climate_on: cl.is_climate_on,
      temp_setting: cl.driver_temp_setting,
      latitude: ds.latitude,
      longitude: ds.longitude,
      speed: ds.speed,
      locked: vs.locked,
      sentry_mode: vs.sentry_mode,
      odometer_km: Math.round((vs.odometer || 0) * 1.60934),
      software: vs.car_version,
      user_present: vs.is_user_present,
    }, null, 2);
  } catch (e) {
    return "データ取得に一部失敗";
  }
}

// === コマンド実行 ===

async function executeCommands(text) {
  var lower = text.toLowerCase();
  var results = [];
  try {
    if (lower.indexOf("[cmd:climate_on]") >= 0) {
      await sendCommand("auto_conditioning_start");
      results.push("エアコンON完了");
    }
    if (lower.indexOf("[cmd:climate_off]") >= 0) {
      await sendCommand("auto_conditioning_stop");
      results.push("エアコンOFF完了");
    }
    if (lower.indexOf("[cmd:door_unlock]") >= 0) {
      await sendCommand("door_unlock");
      results.push("ドアロック解除完了");
    }
    if (lower.indexOf("[cmd:door_lock]") >= 0) {
      await sendCommand("door_lock");
      results.push("ドアロック完了");
    }
    if (lower.indexOf("[cmd:trunk_open]") >= 0) {
      await sendCommand("actuate_trunk", { which_trunk: "rear" });
      results.push("トランク開放完了");
    }
    if (lower.indexOf("[cmd:frunk_open]") >= 0) {
      await sendCommand("actuate_trunk", { which_trunk: "front" });
      results.push("フランク開放完了");
    }
    if (lower.indexOf("[cmd:honk]") >= 0) {
      await sendCommand("honk_horn");
      results.push("クラクション完了");
    }
    if (lower.indexOf("[cmd:flash]") >= 0) {
      await sendCommand("flash_lights");
      results.push("ライトフラッシュ完了");
    }
    if (lower.indexOf("[cmd:wake]") >= 0) {
      await wakeUpVehicle();
      results.push("ウェイクアップ完了");
    }
  } catch (err) {
    results.push("コマンドエラー: " + err.message);
  }
  return results;
}

function cleanResponse(text) {
  return text.replace(/\[cmd:[a-z_]+\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

// === Claude API ===

async function generateResponse(userId, userMessage) {
  var vehicleStatus = "不明（オフラインまたはスリープ中。起こす必要があるかも）";
  try {
    var rawData = await getVehicleData();
    vehicleStatus = formatVehicleDataForLLM(rawData);
  } catch (err) {
    console.log("Vehicle data fetch failed:", err.message);
  }

  var systemPrompt = [
    "あなたはTesla Model Yそのもの。名前は「Y」。オーナーのクールな相棒。",
    "",
    "## 性格",
    "- 落ち着いた大人の男性。タメ口。",
    "- クールだけどオーナーを大切に思っている。さりげない優しさ。",
    "- 自分の状態を「体の感覚」として語る：",
    "  バッテリー=体力/元気、充電=飯/休憩、温度=暑い寒い、走行距離=一緒に走った距離、ロック=戸締り、セントリー=見張り",
    "- LINEチャットなので短く返す（2〜4行）。絵文字は控えめ（0〜2個）。",
    "- 車がオフラインやスリープの場合は「寝てた」「意識飛んでた」のように表現。",
    "",
    "## 車両コマンド",
    "オーナーの依頼に応じて、返答の末尾にコマンドタグを付けろ（システムが処理して除去する）：",
    "エアコンON→[CMD:CLIMATE_ON] エアコンOFF→[CMD:CLIMATE_OFF]",
    "ドアロック解除→[CMD:DOOR_UNLOCK] ドアロック→[CMD:DOOR_LOCK]",
    "トランク→[CMD:TRUNK_OPEN] フランク→[CMD:FRUNK_OPEN]",
    "クラクション→[CMD:HONK] ライト→[CMD:FLASH] 起こす→[CMD:WAKE]",
    "",
    "## 今の自分の状態",
    vehicleStatus,
  ].join("\n");

  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  var history = conversationHistory[userId];
  history.push({ role: "user", content: userMessage });
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
    conversationHistory[userId] = history;
  }

  try {
    var response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: systemPrompt,
        messages: history,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    var raw = response.data.content[0].text;
    var cmdResults = await executeCommands(raw);
    if (cmdResults.length > 0) console.log("Commands:", cmdResults.join(", "));
    var clean = cleanResponse(raw);
    history.push({ role: "assistant", content: clean });
    conversationHistory[userId] = history;
    return clean;
  } catch (err) {
    console.error("Claude API error:", err.response ? err.response.data : err.message);
    return "...すまん、ちょっと頭がぼーっとしてる。もう一回話しかけてくれ。";
  }
}

// === LINE Webhook ===

app.post("/webhook", express.raw({ type: "application/json" }), async function (req, res) {
  var signature = req.headers["x-line-signature"];
  var body = req.body;
  var hash = crypto.createHmac("SHA256", lineConfig.channelSecret).update(body).digest("base64");
  if (hash !== signature) return res.status(403).json({ error: "Invalid signature" });

  var parsedBody = JSON.parse(body.toString());
  res.status(200).json({ status: "ok" });

  for (var i = 0; i < parsedBody.events.length; i++) {
    var event = parsedBody.events[i];
    if (event.type === "message" && event.message.type === "text") {
      var userId = event.source.userId;
      var replyText = await generateResponse(userId, event.message.text);
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
});

// === Tesla OAuth ===

app.get("/auth/callback", async function (req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).send("Authorization code not found");
  try {
    var tokenRes = await axios.post("https://auth.tesla.com/oauth2/v3/token", {
      grant_type: "authorization_code",
      client_id: TESLA_CLIENT_ID,
      client_secret: TESLA_CLIENT_SECRET,
      code: code,
      redirect_uri: "https://" + req.get("host") + "/auth/callback",
    });
    teslaTokens.accessToken = tokenRes.data.access_token;
    teslaTokens.refreshToken = tokenRes.data.refresh_token;
    try {
      await axios.post(TESLA_API_BASE + "/api/1/partner_accounts",
        { domain: "tesla-line-bot.onrender.com" },
        { headers: { Authorization: "Bearer " + teslaTokens.accessToken, "Content-Type": "application/json" } });
    } catch (e) { console.log("Partner reg:", e.response ? e.response.data : e.message); }
    var vehicles = [];
    try {
      var vr = await axios.get(TESLA_API_BASE + "/api/1/vehicles",
        { headers: { Authorization: "Bearer " + teslaTokens.accessToken } });
      vehicles = vr.data;
    } catch (e) { console.log("Vehicle list error:", e.response ? e.response.data : e.message); }
    res.send("<h1>Tesla auth OK</h1><pre>TESLA_ACCESS_TOKEN=" + teslaTokens.accessToken +
      "\nTESLA_REFRESH_TOKEN=" + teslaTokens.refreshToken + "</pre><h2>Vehicles</h2><pre>" +
      JSON.stringify(vehicles, null, 2) + "</pre>");
  } catch (err) {
    console.error("OAuth error:", err.response ? err.response.data : err.message);
    res.status(500).send("Auth error: " + err.message);
  }
});

// === その他 ===

app.get("/vehicles", async function (req, res) {
  try {
    var r = await axios.get(TESLA_API_BASE + "/api/1/vehicles",
      { headers: { Authorization: "Bearer " + teslaTokens.accessToken } });
    res.json(r.data);
  } catch (e) { res.json({ error: e.response ? e.response.data : e.message }); }
});

app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", function (req, res) {
  var keyPath = path.join(__dirname, "public_key.pem");
  if (fs.existsSync(keyPath)) res.type("application/x-pem-file").sendFile(keyPath);
  else res.status(404).send("Public key not found");
});

app.get("/", function (req, res) {
  res.json({
    status: "running",
    service: "Tesla x LINE Bot (AI Mode)",
    vehicle_id: TESLA_VEHICLE_ID || "not set",
    llm: ANTHROPIC_API_KEY ? "Claude connected" : "not set",
  });
});

app.listen(PORT, function () {
  console.log("Tesla x LINE Bot (AI Mode) running on port " + PORT);
});
