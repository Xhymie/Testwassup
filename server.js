const express = require("express");
const { randomUUID } = require("node:crypto");
const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "benim_gizli_dogrulama_kodum";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1553594594490625";
const GRAPH_VERSION = "v25.0";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeText = (value) => typeof value === "string" ? value.slice(0, 500) : null;
const maskPhone = (value) => typeof value === "string" ? `***${value.slice(-4)}` : null;

// Ham body, header, token ve serbest mesaj metinleri loglanmaz; buton seçimi kaydedilir.
function log(event, details = {}) {
  console.log(JSON.stringify({ zaman: new Date().toISOString(), olay: event, ...details }));
}

// JSON ayrıştırması başarısız olsa bile gelen webhook isteği görünür olsun.
app.use((req, res, next) => {
  req.requestId = randomUUID();
  if (req.method === "POST" && req.path === "/webhook") {
    log("WEBHOOK ISTEK", { istekId: req.requestId });
    res.on("finish", () => log("WEBHOOK YANIT", {
      istekId: req.requestId, httpDurum: res.statusCode,
    }));
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

function eventArray(parent, key, context) {
  if (Array.isArray(parent?.[key])) return parent[key];
  if (parent?.[key] !== undefined) {
    log("WEBHOOK YAPI UYARISI", { ...context, alan: key, neden: "Dizi bekleniyor." });
  }
  return [];
}

app.get("/", (req, res) => {
  res.status(200).send("Inkaport WA Anket Webhook aktif.");
});

// 1) Meta Webhook Doğrulama (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook doğrulandı.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Gelen Olaylar: Okundu bilgisi ve Buton/Anket yanıtları (POST)
app.post("/webhook", (req, res) => {
  const context = { istekId: req.requestId };
  const entries = eventArray(req.body, "entry", context);
  let statusCount = 0;
  let messageCount = 0;

  for (const [entryIndex, entry] of entries.entries()) {
    const changes = eventArray(entry, "changes", { ...context, entryIndex });
    for (const [changeIndex, change] of changes.entries()) {
      const value = change?.value;
      const eventContext = {
        ...context, entryIndex, changeIndex,
        field: safeText(change?.field),
        messagingProduct: safeText(value?.messaging_product),
        phoneNumberId: safeText(value?.metadata?.phone_number_id),
      };
      if (!isObject(value)) {
        log("WEBHOOK YAPI UYARISI", { ...eventContext, neden: "value nesnesi eksik veya geçersiz." });
        continue;
      }
      // Test ve eksik payloadlarda alan yok diye olayları sessizce atlama.
      if ((change.field !== undefined && change.field !== "messages") ||
          (value.messaging_product !== undefined && value.messaging_product !== "whatsapp")) {
        log("WEBHOOK YAPI UYARISI", { ...eventContext, neden: "Beklenmeyen field veya messaging_product." });
      }

      for (const st of eventArray(value, "statuses", eventContext)) {
        if (!isObject(st)) {
          log("WEBHOOK YAPI UYARISI", { ...eventContext, neden: "Geçersiz status kaydı." });
          continue;
        }
        statusCount++;
        log("DURUM", {
          ...eventContext,
          alici: maskPhone(st.recipient_id),
          durum: safeText(st.status),
          metaZaman: safeText(st.timestamp),
          mesajId: safeText(st.id),
          hataKodlari: Array.isArray(st.errors)
            ? st.errors.map((error) => Number.isInteger(error?.code) ? error.code : null) : [],
        });
      }

      for (const msg of eventArray(value, "messages", eventContext)) {
        if (!isObject(msg)) {
          log("WEBHOOK YAPI UYARISI", { ...eventContext, neden: "Geçersiz message kaydı." });
          continue;
        }
        messageCount++;
        const messageContext = {
          ...eventContext,
          kimden: maskPhone(msg.from),
          mesajId: safeText(msg.id),
          baglamMesajId: safeText(msg.context?.id),
          metaZaman: safeText(msg.timestamp),
          tip: safeText(msg.type),
        };
        const reply = msg.interactive?.button_reply;
        if (msg.type === "interactive" && isObject(reply)) {
          log("ANKET YANITI", {
            ...messageContext,
            button_reply: { id: safeText(reply.id), title: safeText(reply.title) },
          });
        } else if (msg.type === "button" && isObject(msg.button)) {
          // Şablon quick-reply butonları farklı bir mesaj yapısı kullanır.
          log("BUTON YANITI", {
            ...messageContext,
            button: { payload: safeText(msg.button.payload), text: safeText(msg.button.text) },
          });
        } else {
          log("MESAJ", { ...messageContext, interactiveTip: safeText(msg.interactive?.type) });
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            log("WEBHOOK YAPI UYARISI", { ...messageContext, neden: "button_reply nesnesi eksik veya geçersiz." });
          }
        }
      }
      for (const error of eventArray(value, "errors", eventContext)) {
        log("WEBHOOK META HATASI", {
          ...eventContext, kod: Number.isInteger(error?.code) ? error.code : null,
        });
      }
    }
  }
  log("WEBHOOK OZET", {
    ...context, object: safeText(req.body?.object),
    entrySayisi: entries.length, durumSayisi: statusCount, mesajSayisi: messageCount,
  });
  if (!statusCount && !messageCount) {
    log("WEBHOOK YAPI UYARISI", { ...context, neden: "İşlenebilir statuses/messages kaydı bulunamadı." });
  }
  return res.sendStatus(200);
});

// 3) Butonlu eğitim anketi gönderen endpoint
app.post("/anket-gonder", async (req, res) => {
  if (!isObject(req.body)) {
    return res.status(400).json({ hata: "JSON nesnesi gerekli." });
  }
  for (const key of ["token", "phoneNumberId", "to"]) {
    if (req.body[key] !== undefined && typeof req.body[key] !== "string") {
      return res.status(400).json({ hata: `${key} alanı metin olmalı.` });
    }
  }
  const token = req.body.token?.trim() || process.env.WA_TOKEN?.trim();
  const phoneNumberId = req.body.phoneNumberId?.trim() || PHONE_NUMBER_ID.trim();
  const to = req.body.to?.trim();

  if (!token) {
    return res.status(400).json({ hata: "Token bulunamadı (body.token veya WA_TOKEN gerekli)." });
  }
  if (!to || !/^[1-9]\d{6,14}$/.test(to)) {
    return res.status(400).json({ hata: "to, ülke kodu dahil 7–15 rakam olmalı; + veya boşluk içermemeli." });
  }
  if (!/^\d+$/.test(phoneNumberId)) {
    return res.status(400).json({ hata: "phoneNumberId yalnızca rakamlardan oluşmalı." });
  }
  if (/\s/.test(token)) {
    return res.status(400).json({ hata: "Token boşluk içeremez; yalnızca access token değerini gönder." });
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "Bugünkü eğitimi nasıl değerlendirirsin?",
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "ANKET_COK_IYI", title: "Çok İyi" } },
          { type: "reply", reply: { id: "ANKET_ORTA", title: "Orta" } },
          { type: "reply", reply: { id: "ANKET_GELISTIRILMELI", title: "Geliştirilmeli" } },
        ],
      },
    },
  };

  log("ANKET GONDERIM", {
    istekId: req.requestId, alici: maskPhone(to), phoneNumberId, graphVersion: GRAPH_VERSION,
    tokenKaynagi: req.body.token?.trim() ? "body" : "WA_TOKEN",
    phoneNumberIdKaynagi: req.body.phoneNumberId?.trim() ? "body" : process.env.PHONE_NUMBER_ID ? "env" : "varsayilan",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      log("META YANIT HATASI", { istekId: req.requestId, httpDurum: response.status, neden: "JSON olmayan yanıt." });
      return res.status(502).json({ hata: "Meta API geçerli JSON yanıtı döndürmedi." });
    }
    log("META YANITI", {
      istekId: req.requestId, httpDurum: response.status, phoneNumberId,
      mesajId: safeText(data?.messages?.[0]?.id),
      hataKodu: Number.isInteger(data?.error?.code) ? data.error.code : null,
      hataAltKodu: Number.isInteger(data?.error?.error_subcode) ? data.error.error_subcode : null,
    });
    return res.status(response.ok ? 200 : 400).json(data);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    log("ANKET ISTEK HATASI", { istekId: req.requestId, neden: timedOut ? "Zaman aşımı." : "Meta bağlantısı başarısız." });
    return res.status(timedOut ? 504 : 502).json({
      hata: timedOut ? "Meta isteği zaman aşımına uğradı; yeniden göndermeden önce teslim durumunu kontrol et." : "Meta API bağlantısı başarısız.",
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  log("HTTP HATASI", { istekId: req.requestId, httpDurum: status });
  return res.status(status).json({ hata: status === 400 ? "Geçersiz JSON veya istek gövdesi." : "İstek işlenemedi." });
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
