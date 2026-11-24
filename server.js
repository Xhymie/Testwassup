const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "benim_gizli_dogrulama_kodum";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1553594594490625";
const ACCESS_TOKEN = process.env.WA_TOKEN;
const GRAPH_VERSION = "v25.0";

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
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return res.sendStatus(200);

  if (value.statuses?.length) {
    for (const st of value.statuses) {
      console.log("[DURUM]", {
        alici: st.recipient_id,
        durum: st.status, // sent, delivered, read
        zaman: st.timestamp,
        mesajId: st.id,
      });
    }
  }

  if (value.messages?.length) {
    for (const msg of value.messages) {
      if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
        console.log("[ANKET YANITI]", {
          kimden: msg.from,
          secimId: msg.interactive.button_reply.id,
          secimMetni: msg.interactive.button_reply.title,
          baglamMesajId: msg.context?.id,
        });
      } else {
        console.log("[MESAJ]", { kimden: msg.from, tip: msg.type, icerik: msg });
      }
    }
  }

  return res.sendStatus(200);
});

// 3) Butonlu eğitim anketi gönderen endpoint
app.post("/anket-gonder", async (req, res) => {
  if (!ACCESS_TOKEN) {
    return res.status(500).json({ hata: "WA_TOKEN ortam değişkeni tanımlı değil." });
  }

  const to = req.body.to;
  if (!to) return res.status(400).json({ hata: "to alanı gerekli (örn: 905011422468)" });

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return res.status(response.ok ? 200 : 400).json(data);
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});