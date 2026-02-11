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

// --- LINE 設定 ---
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

// --- Tesla 設定 ---
var teslaTokens = {
  accessToken: process.env.TESLA_ACCESS_TOKEN,
  refreshToken: process.env.TESLA_REFRESH_TOKEN,
};
var TESLA_VEHICLE_ID = process.env.TESLA_VEHICLE_ID;
var TESLA_API_BASE = process.env.TESLA_API_BASE || "https://fleet-api.prd.na.vn.cloud.tesla.com";
var TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
var TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;

// --- Tesla API ヘルパー ---
async function refreshTeslaToken() {
  try {
    var res = await axios.post("https://auth.tesla.com/oauth2/v3/token", {
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
      var refreshed = await refreshTeslaToken();
      if (refreshed) {
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
    await new Promise(function (resolve) { setTimeout(resolve, 5000); });
  } catch (err) {
    console.error("Wake up failed:", err.message);
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

// --- メッセージ処理 ---
async function handleMessage(userMessage) {
  var msg = userMessage.toLowerCase();

  try {
    if (msg.indexOf("バッテリー") >= 0 || msg.indexOf("充電") >= 0 || msg.indexOf("電池") >= 0 || msg.indexOf("残量") >= 0) {
      var data = await getVehicleData();
      var cs = data.charge_state;
      var result = "🔋 バッテリー情報\n\n残量: " + cs.battery_level + "%\n航続距離: " + Math.round(cs.battery_range * 1.60934) + " km\n充電状態: " + (cs.charging_state === "Disconnected" ? "未接続" : cs.charging_state === "Charging" ? "充電中" : cs.charging_state) + "\n充電上限: " + cs.charge_limit_soc + "%";
      if (cs.time_to_full_charge > 0) result += "\n満充電まで: 約" + Math.round(cs.time_to_full_charge * 60) + "分";
      return result;
    }

    if (msg.indexOf("エアコンつけて") >= 0 || msg.indexOf("エアコンオン") >= 0 || msg.indexOf("暖めて") >= 0 || msg.indexOf("プレコン") >= 0) {
      await sendCommand("auto_conditioning_start");
      return "✅ エアコンをONにしました！\n車内が快適になるまでお待ちください 🚗";
    }

    if (msg.indexOf("エアコン消して") >= 0 || msg.indexOf("エアコンオフ") >= 0 || msg.indexOf("エアコン止めて") >= 0) {
      await sendCommand("auto_conditioning_stop");
      return "✅ エアコンをOFFにしました。";
    }

    if (msg.indexOf("エアコン") >= 0 || msg.indexOf("温度") >= 0 || msg.indexOf("空調") >= 0) {
      var data = await getVehicleData();
      var cl = data.climate_state;
      return "🌡️ 空調情報\n\n車内温度: " + cl.inside_temp + "°C\n外気温: " + cl.outside_temp + "°C\nエアコン: " + (cl.is_climate_on ? "ON" : "OFF") + "\n設定温度: " + cl.driver_temp_setting + "°C";
    }

    if (msg.indexOf("場所") >= 0 || msg.indexOf("位置") >= 0 || msg.indexOf("どこ") >= 0 || msg.indexOf("駐車") >= 0) {
      var data = await getVehicleData();
      var ds = data.drive_state;
      return "📍 現在位置\n\nhttps://maps.google.com/?q=" + ds.latitude + "," + ds.longitude;
    }

    if (msg.indexOf("ロック解除") >= 0 || msg.indexOf("アンロック") >= 0 || msg.indexOf("鍵開けて") >= 0 || msg.indexOf("開錠") >= 0) {
      await sendCommand("door_unlock");
      return "🔓 ドアロックを解除しました！";
    }

    if (msg.indexOf("施錠") >= 0 || msg.indexOf("ロックして") >= 0) {
      await sendCommand("door_lock");
      return "🔒 ドアをロックしました！";
    }

    if (msg.indexOf("ロック") >= 0 || msg.indexOf("鍵") >= 0) {
      var data = await getVehicleData();
      var vs = data.vehicle_state;
      return "🔒 ロック状態\n\nドア: " + (vs.locked ? "施錠済み ✅" : "解錠中 ⚠️") + "\nセントリーモード: " + (vs.sentry_mode ? "ON" : "OFF");
    }

    if (msg.indexOf("トランク") >= 0 && msg.indexOf("開") >= 0) {
      await sendCommand("actuate_trunk", { which_trunk: "rear" });
      return "✅ リアトランクを開けました！ 📦";
    }

    if (msg.indexOf("フランク") >= 0 && msg.indexOf("開") >= 0) {
      await sendCommand("actuate_trunk", { which_trunk: "front" });
      return "✅ フランク（前トランク）を開けました！";
    }

    if (msg.indexOf("クラクション") >= 0 || msg.indexOf("ホーン") >= 0) {
      await sendCommand("honk_horn");
      return "📢 クラクションを鳴らしました！";
    }

    if (msg.indexOf("フラッシュ") >= 0 || msg.indexOf("ライト") >= 0) {
      await sendCommand("flash_lights");
      return "💡 ヘッドライトをフラッシュしました！ ✨";
    }

    if (msg.indexOf("セントリー") >= 0 || msg.indexOf("監視") >= 0) {
      var data = await getVehicleData();
      return "👁️ セントリーモード: " + (data.vehicle_state.sentry_mode ? "有効 ✅" : "無効");
    }

    if (msg.indexOf("走行距離") >= 0 || msg.indexOf("オドメーター") >= 0 || msg.indexOf("距離") >= 0) {
      var data = await getVehicleData();
      var km = Math.round(data.vehicle_state.odometer * 1.60934);
      return "🛣️ 走行情報\n\n総走行距離: " + km.toLocaleString() + " km\nソフトウェア: " + data.vehicle_state.car_version;
    }

    if (msg.indexOf("状態") >= 0 || msg.indexOf("ステータス") >= 0 || msg.indexOf("調子") >= 0 || msg.indexOf("元気") >= 0) {
      var data = await getVehicleData();
      var cs = data.charge_state;
      var cl = data.climate_state;
      var vs = data.vehicle_state;
      var km = Math.round(vs.odometer * 1.60934);
      return "🚗 " + (data.display_name || "Model Y") + " の状態\n\n🔋 バッテリー: " + cs.battery_level + "% (" + Math.round(cs.battery_range * 1.60934) + "km)\n🌡️ 車内: " + cl.inside_temp + "°C / 外: " + cl.outside_temp + "°C\n❄️ エアコン: " + (cl.is_climate_on ? "ON" : "OFF") + "\n🔒 ロック: " + (vs.locked ? "施錠済み" : "解錠中") + "\n👁️ セントリー: " + (vs.sentry_mode ? "ON" : "OFF") + "\n🛣️ 走行距離: " + km.toLocaleString() + " km\n📡 ソフトウェア: " + vs.car_version;
    }

    if (msg.indexOf("ヘルプ") >= 0 || msg.indexOf("使い方") >= 0 || msg.indexOf("何ができる") >= 0 || msg.indexOf("コマンド") >= 0) {
      return "💬 使えるコマンド\n\n🔋「バッテリー」→ 残量確認\n🌡️「エアコン」→ 温度確認\n❄️「エアコンつけて」→ エアコンON\n📍「どこ？」→ 位置情報\n🔒「ロック」→ 施錠状態確認\n🔓「ロック解除」→ 解錠\n🔐「施錠して」→ ロック\n🚗「ステータス」→ 全体状態\n📦「トランク開けて」→ 開閉\n📢「クラクション」→ ホーン\n💡「フラッシュ」→ ライト\n👁️「セントリー」→ 監視状態";
    }

    return "すみません、よくわかりませんでした 🤔\n「ヘルプ」と送ると使えるコマンド一覧を表示します！";
  } catch (err) {
    console.error("Error handling message:", err.response ? err.response.data : err.message);
    return "⚠️ エラーが発生しました\n\n" + (err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message) + "\n\nしばらく待ってから再度お試しください。";
  }
}

// --- Webhook ---
app.post("/webhook", express.raw({ type: "application/json" }), async function (req, res) {
  var signature = req.headers["x-line-signature"];
  var body = req.body;

  var hash = crypto.createHmac("SHA256", lineConfig.channelSecret).update(body).digest("base64");

  if (hash !== signature) {
    console.error("Invalid signature");
    return res.status(403).json({ error: "Invalid signature" });
  }

  var parsedBody = JSON.parse(body.toString());
  res.status(200).json({ status: "ok" });

  for (var i = 0; i < parsedBody.events.length; i++) {
    var event = parsedBody.events[i];
    if (event.type === "message" && event.message.type === "text") {
      var replyText = await handleMessage(event.message.text);
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

// --- Tesla OAuth コールバック ---
app.get("/auth/callback", async function (req, res) {
  var code = req.query.code;

  if (!code) {
    return res.status(400).send("Authorization code not found");
  }

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

    // パートナー登録
    try {
      await axios.post(
        TESLA_API_BASE + "/api/1/partner_accounts",
        { domain: "tesla-line-bot.onrender.com" },
        { headers: { Authorization: "Bearer " + teslaTokens.accessToken, "Content-Type": "application/json" } }
      );
      console.log("Partner registration success");
    } catch (e) {
      console.log("Partner registration:", e.response ? e.response.data : e.message);
    }

    // 車両一覧を取得
    var vehicles = [];
    try {
      var vehiclesRes = await axios.get(TESLA_API_BASE + "/api/1/vehicles", {
        headers: { Authorization: "Bearer " + teslaTokens.accessToken },
      });
      vehicles = vehiclesRes.data;
    } catch (e) {
      console.log("Vehicle list error:", e.response ? e.response.data : e.message);
    }

    res.send(
      "<h1>Tesla 認証成功！</h1>" +
      "<h2>トークン情報（Renderの環境変数に保存してください）</h2>" +
      "<pre>TESLA_ACCESS_TOKEN=" + teslaTokens.accessToken + "\nTESLA_REFRESH_TOKEN=" + teslaTokens.refreshToken + "</pre>" +
      "<h2>車両一覧</h2>" +
      "<pre>" + JSON.stringify(vehicles, null, 2) + "</pre>" +
      "<p>vehicle の id を Render の TESLA_VEHICLE_ID に設定してください。</p>"
    );
  } catch (err) {
    console.error("OAuth error:", err.response ? err.response.data : err.message);
    res.status(500).send("認証エラー: " + err.message);
  }
});

// --- 車両一覧確認用 ---
app.get("/vehicles", async function (req, res) {
  try {
    var r = await axios.get(TESLA_API_BASE + "/api/1/vehicles", {
      headers: { Authorization: "Bearer " + teslaTokens.accessToken },
    });
    res.json(r.data);
  } catch (e) {
    res.json({ error: e.response ? e.response.data : e.message });
  }
});

// --- 公開鍵ホスティング ---
app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", function (req, res) {
  var keyPath = path.join(__dirname, "public_key.pem");
  if (fs.existsSync(keyPath)) {
    res.type("application/x-pem-file").sendFile(keyPath);
  } else {
    res.status(404).send("Public key not found");
  }
});

// --- ヘルスチェック ---
app.get("/", function (req, res) {
  res.json({
    status: "running",
    service: "Tesla x LINE Bot",
    vehicle_id: TESLA_VEHICLE_ID || "not set",
  });
});

// --- サーバー起動 ---
app.listen(PORT, function () {
  console.log("Tesla x LINE Bot server running on port " + PORT);
});
