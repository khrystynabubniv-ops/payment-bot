const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const sessions = {};
function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: "home", data: {} };
  return sessions[userId];
}
function resetSession(userId) {
  sessions[userId] = { step: "home", data: {} };
}

const TITAN_URL = "https://titan.gen.tech/site/login";
const TITAN_NOTION = "https://www.notion.so/Paidlog-Titan-6132cf4d98ae4a33a8dd3f85ad849d85";
const CARDS_NOTION = "https://www.notion.so/18bce9899cb78129a33bfaa08c75a1fb";
const INVOICE_URL = "https://docs.google.com/document/d/1Fka7KxOR6q9453QfSEoN97fhvJUAXFss/export?format=docx";

const TITAN_INSTRUCTIONS = `*Як створити запит у Titan:*
1. Відкрий <${TITAN_URL}|Titan> та залогінься
2. Перейди до *Paidlog → Requests*
3. Натисни *"New Request"*
4. Заповни: отримувач, сума, валюта, призначення
5. Прикріпи *договір* та *інвойс*
6. Відправ на погодження

📖 <${TITAN_NOTION}|Детальна інструкція по Titan>`;

const INVOICE_BLOCK = `📄 *Шаблон інвойсу:* <${INVOICE_URL}|Завантажити Invoice USD Universe.docx>

*Головне щоб в інвойсі були зазначені:*
1. Наша компанія — *GM UniverseApps Limited*, Cyprus
2. Імʼя і повна адреса отримувача (контрагента)
3. Суть послуг і сума
4. Номер і дата
5. Банківські реквізити отримувача

_Якщо у контрагента є власний шаблон — ок, головне щоб всі пункти були присутні._`;

function s(text) { return { type: "section", text: { type: "mrkdwn", text } }; }
function divider() { return { type: "divider" }; }
function actions(buttons) {
  return {
    type: "actions",
    elements: buttons.map(([label, value, style]) => ({
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      value,
      action_id: "btn_" + value,
      ...(style ? { style } : {}),
    })),
  };
}
function questionMsg(text, buttons) {
  return { blocks: [s(text), actions(buttons)] };
}
function resultMsg(title, details, extra) {
  return {
    blocks: [
      s(title), divider(), s(details),
      ...(extra ? [divider(), s(extra)] : []),
      divider(),
      actions([["🔄 Почати знову", "restart", "primary"]]),
    ],
  };
}

const FIRST_QUESTION = questionMsg(
  "👋 *Визначення способу оплати*\n\nОбери варіант оплати, який доступний у контрагента — і я підкажу що робити далі:",
  [
    ["💳 Картка фізособи", "card"],
    ["🖥 Термінал", "terminal"],
    ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
    ["🌐 Онлайн-підписка", "online"],
    ["🏦 Тільки реквізити", "requisites"],
  ]
);

// Вибір методу з нашого боку для ФОП3/ТОВ
function ourMethodQuestion(context) {
  return questionMsg(
    `💡 *${context}*\n\nОбери зручний спосіб оплати з нашого боку:`,
    [
      ["🌍 З нерезидента через Titan (USD/EUR)", "method_nonresident"],
      ["💳 З корпоративної картки (прямий переказ)", "method_corp"],
      ["📱 З картки фізособи (Mono грн)", "method_phys"],
    ]
  );
}

// Home tab

// Home tab — статичний екран з інструкцією
app.event("app_home_opened", async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          s("💳 *Payment Bot*"),
          s("Я допоможу визначити правильний спосіб оплати контрагенту — крок за кроком."),
          { type: "divider" },
          s("*Як почати:*

1️⃣ Перейди у вкладку *Messages* вище
2️⃣ Напиши будь-що або використай команду `/payment`
3️⃣ Відповідай на питання — і я підкажу що робити"),
          { type: "divider" },
          s("_Бот доступний для всієї команди Genesis Tech_"),
        ],
      },
    });
  } catch (e) { console.error("Home error:", e?.data || e); }
});

// Зберігаємо кого вже привітали щоб не спамити
const greeted = new Set();

app.event("message", async ({ event, client }) => {
  if (event.channel_type !== "im") return;
  if (event.bot_id || event.subtype) return;
  const userId = event.user;
  if (!userId) return;
  if (!greeted.has(userId)) {
    greeted.add(userId);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        blocks: [
          s("👋 *Привіт! Я допоможу визначити правильний спосіб оплати контрагенту.*\n\nНатисни кнопку нижче — і я крок за кроком підкажу який метод обрати."),
          actions([["💳 Провести оплату", "start_payment", "primary"]]),
        ],
      });
    } catch (e) { console.error("Greet error:", e?.data || e); }
  }
});


// Slash command
app.command("/payment", async ({ command, ack, client }) => {
  await ack();
  const userId = command.user_id;
  resetSession(userId);
  getSession(userId).step = "payment_type";
  await client.chat.postMessage({ channel: command.channel_id, ...FIRST_QUESTION });
});

// Button clicks
app.action(/^btn_/, async ({ action, body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel?.id;
  const ts = body.message?.ts;
  const value = action.value;
  const label = action.text?.text || value;

  if (ts && channelId && value !== "restart" && value !== "start_payment") {
    try {
      const originalText = body.message?.blocks?.[0]?.text?.text || "";
      await client.chat.update({
        channel: channelId,
        ts,
        blocks: [s(originalText), s(`_Обрано: *${label}*_`)],
      });
    } catch (e) { console.error("Update error:", e?.data || e); }
  }

  await handleStep(client, userId, channelId, value);
});

async function post(client, channelId, payload) {
  return await client.chat.postMessage({ channel: channelId, ...payload });
}

// Результат: нерезидент через Titan (картка)
async function resultNonresidentCard(client, channelId, amount) {
  if (amount === "high") {
    await post(client, channelId, resultMsg(
      "✅ *Запит у Titan — оплата на картку фізособи*",
      `⚠️ Сума перевищує 2 500 USD — *спочатку* напиши Ані Колесник у Slack (@anna.kolesnyk) або anna.kolesnyk@uni.tech.\n\n*Навіщо?* Великі платежі на картку можуть викликати питання від банку — Аня погоджує і за потреби координує розбивку.\n\nПісля підтвердження:\n${TITAN_INSTRUCTIONS}\n\n*У коментарях:* номер картки та ПІБ отримувача.\nPayment method: \`CARD\`\n\n💡 Якщо сума значно вища — краще розбити на кілька платежів або різні картки.`
    ));
  } else {
    await post(client, channelId, resultMsg(
      "✅ *Запит у Titan — оплата на картку фізособи*",
      `${TITAN_INSTRUCTIONS}\n\n*У коментарях до запиту:* вкажи номер картки та ПІБ отримувача.\nPayment method: \`CARD\``
    ));
  }
}

// Результат: нерезидент через Titan (реквізити)
async function resultNonresidentRequisites(client, channelId) {
  await post(client, channelId, resultMsg(
    "✅ *Оплата з нерезидента — запит у Titan*",
    `Попроси контрагента виставити рахунок у *USD або EUR* на:\n*GM Universeapps Limited, Cyprus*\n\n${TITAN_INSTRUCTIONS}`,
    INVOICE_BLOCK
  ));
}

async function handleStep(client, userId, channelId, action) {
  const session = getSession(userId);

  if (action === "restart") {
    resetSession(userId);
    getSession(userId).step = "payment_type";
    await post(client, channelId, FIRST_QUESTION);
    return;
  }

  if (action === "start_payment") {
    resetSession(userId);
    getSession(userId).step = "payment_type";
    await post(client, channelId || userId, FIRST_QUESTION);
    return;
  }

  const step = session.step;

  // ── КРОК 1: що доступно у контрагента ───────────────────────────
  if (step === "payment_type") {
    session.data.paymentType = action;

    if (["terminal", "link", "online"].includes(action)) {
      await post(client, channelId, resultMsg(
        "✅ *Корпоративна картка або картка фізособи*",
        `Термінал, онлайн-посилання та підписки оплачуються:\n• Корпоративною карткою\n• Або грн Mono карткою фізособи\n\n💳 <${CARDS_NOTION}|Реквізити корпоративних карток>`
      ));
      resetSession(userId);
      return;
    }

    if (action === "card") {
      session.step = "card_our_method";
      await post(client, channelId, ourMethodQuestion("Контрагент приймає оплату на картку фізособи."));
      return;
    }

    if (action === "requisites") {
      session.step = "has_fx";
      await post(client, channelId, questionMsg(
        "🏦 *Уточни у контрагента три речі:*\n\n1️⃣ Чи є валютний рахунок (USD або EUR)?\n2️⃣ Чи може прийняти оплату від іноземної компанії?\n3️⃣ Чи можна вказати у призначенні: реклама, консультації, дизайн або IT?\n\nОбери відповідь яка найбільше підходить:",
        [["✅ Так, всі три — так", "yes"], ["❌ Ні, тільки гривня (UAH)", "no"]]
      ));
      return;
    }
  }

  // ── КРОК 2а: наш метод для картки ───────────────────────────────
  if (step === "card_our_method") {
    if (action === "method_nonresident") {
      session.step = "card_nonresident_amount";
      await post(client, channelId, questionMsg(
        "💰 *Яка приблизна сума оплати?*\n\nВід цього залежить чи потрібне додаткове погодження:",
        [["До 2 500 USD", "low"], ["Більше 2 500 USD", "high"]]
      ));
      return;
    }
    if (action === "method_corp") {
      await post(client, channelId, resultMsg(
        "✅ *Прямий переказ з корпоративної картки*",
        `Переказ здійснюється напряму з корпоративної картки на картку контрагента.\n\n💳 <${CARDS_NOTION}|Реквізити корпоративних карток>\n\n⚠️ Якщо сума вища за 2 500 USD — краще розбити на кілька платежів або різні картки.`
      ));
      resetSession(userId);
      return;
    }
    if (action === "method_phys") {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `Оплата з грн Mono картки фізособи, яка поповнюється через ФОП співробітника.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення картки завчасно.`
      ));
      resetSession(userId);
      return;
    }
  }

  // ── КРОК 2б: сума (нерезидент → картка) ─────────────────────────
  if (step === "card_nonresident_amount") {
    await resultNonresidentCard(client, channelId, action);
    resetSession(userId);
    return;
  }

  // ── КРОК 3: валютний рахунок? ────────────────────────────────────
  if (step === "has_fx") {
    session.data.hasFx = action;
    session.step = "contractor";
    await post(client, channelId, questionMsg(
      "🪪 *Хто є отримувачем коштів?*\n\nОбери статус контрагента — від цього залежить метод оплати:",
      [
        ["ФОП 2 група", "fop2"],
        ["ФОП 3 група", "fop3"],
        ["ТОВ (загальна система)", "tov"],
      ]
    ));
    return;
  }

  // ── КРОК 4: тип контрагента ──────────────────────────────────────
  if (step === "contractor") {
    session.data.contractor = action;

    // ФОП 2 — тільки картка фізособи
    if (action === "fop2") {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `ФОП 2 групи може приймати оплату тільки від фізосіб — тому платимо з грн Mono картки.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення картки завчасно через ФОП співробітника.`
      ));
      resetSession(userId);
      return;
    }

    // ФОП 3 або ТОВ з валютою → вибір нашого методу
    if (session.data.hasFx === "yes" && ["fop3", "tov"].includes(action)) {
      session.step = "fop3tov_fx_method";
      await post(client, channelId, ourMethodQuestion(`Контрагент (${action.toUpperCase()}) має валютний рахунок.`));
      return;
    }

    // ФОП 3 або ТОВ лише гривня → вибір нашого методу
    if (session.data.hasFx === "no" && ["fop3", "tov"].includes(action)) {
      session.step = "fop3tov_uah_method";
      await post(client, channelId, ourMethodQuestion(`Контрагент (${action.toUpperCase()}) працює лише в гривні.`));
      return;
    }
  }

  // ── КРОК 5а: метод для ФОП3/ТОВ з валютою ───────────────────────
  if (step === "fop3tov_fx_method") {
    if (action === "method_nonresident") {
      session.step = "service_type";
      await post(client, channelId, questionMsg(
        "📦 *Який тип послуги або товару?*\n\nОбери варіант який найбільше підходить до твоєї ситуації:",
        [
          ["📢 Реклама / дизайн / IT / консультації", "neutral"],
          ["🍾 Алкоголь / кейтеринг / розваги / мерч", "catering"],
        ]
      ));
      return;
    }
    if (action === "method_corp") {
      await post(client, channelId, resultMsg(
        "✅ *Прямий переказ з корпоративної картки*",
        `Переказ здійснюється напряму з корпоративної картки.\n\n💳 <${CARDS_NOTION}|Реквізити корпоративних карток>\n\n⚠️ Якщо сума вища за 2 500 USD — краще розбити на кілька платежів.`
      ));
      resetSession(userId);
      return;
    }
    if (action === "method_phys") {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `Оплата з грн Mono картки фізособи, яка поповнюється через ФОП співробітника.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення картки завчасно.`
      ));
      resetSession(userId);
      return;
    }
  }

  // ── КРОК 5б: метод для ФОП3/ТОВ лише гривня ─────────────────────
  if (step === "fop3tov_uah_method") {
    if (action === "method_nonresident") {
      session.step = "service_type";
      await post(client, channelId, questionMsg(
        "📦 *Який тип послуги або товару?*\n\nОбери варіант який найбільше підходить до твоєї ситуації:",
        [
          ["📢 Реклама / дизайн / IT / консультації", "neutral"],
          ["🍾 Алкоголь / кейтеринг / розваги / мерч", "catering"],
        ]
      ));
      return;
    }
    if (action === "method_corp") {
      await post(client, channelId, resultMsg(
        "✅ *Прямий переказ з корпоративної картки*",
        `Переказ здійснюється напряму з корпоративної картки.\n\n💳 <${CARDS_NOTION}|Реквізити корпоративних карток>\n\n⚠️ Якщо сума вища за 2 500 USD — краще розбити на кілька платежів.`
      ));
      resetSession(userId);
      return;
    }
    if (action === "method_phys") {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `Оплата з грн Mono картки фізособи, яка поповнюється через ФОП співробітника.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення картки завчасно.`
      ));
      resetSession(userId);
      return;
    }
    if (action === "method_tov") {
      session.step = "kved_check";
      await post(client, channelId, questionMsg(
        "📋 *Чи підпадає послуга під один із КВЕД?*\n\nНаші ТОВ можуть оплачувати лише ці типи послуг:\n• Дизайн\n• Реклама\n• Консультації з бізнесу або IT\n• Оренда локації (конференції, зустрічі)\n• Оренда техніки / обладнання для офісу\n\nОбери варіант який найбільше підходить:",
        [["✅ Так, підпадає", "kved_yes"], ["❌ Ні, не підпадає", "kved_no"]]
      ));
      return;
    }
  }

  // ── КРОК 6: тип послуги (нерезидент) ────────────────────────────
  if (step === "service_type") {
    if (action === "neutral") {
      await resultNonresidentRequisites(client, channelId);
      resetSession(userId);
      return;
    }
    if (action === "catering") {
      session.step = "can_describe_neutral";
      await post(client, channelId, questionMsg(
        '🔤 *Чи може контрагент описати послугу в інвойсі як одне з:*\n\n• "design services"\n• "organization services"\n• "consulting services"\n• "production of advertising materials"\n\n⚠️ Якщо може написати лише "алкоголь", "сумки", "худі" — цей метод не підійде.\n\nОбери варіант який найбільше підходить:',
        [["✅ Так, може", "yes"], ["❌ Ні, тільки прямий опис товару", "no"]]
      ));
      return;
    }
  }

  // ── КРОК 7: нейтральний опис? ────────────────────────────────────
  if (step === "can_describe_neutral") {
    if (action === "yes") {
      await resultNonresidentRequisites(client, channelId);
    } else {
      await post(client, channelId, resultMsg(
        "⛔ *Оплата з нерезидента неможлива*",
        "Контрагент не може вказати нейтральний опис — цей метод не підходить.\n\nЗверніться до юриста Вікторії — вона підкаже альтернативу:\n📧 viktoria.bobik@gen.tech | Tg: @viktamur"
      ));
    }
    resetSession(userId);
    return;
  }

  // ── КРОК 8: КВЕД ─────────────────────────────────────────────────
  if (step === "kved_check") {
    if (action === "kved_yes") {
      await post(client, channelId, resultMsg(
        "✅ *Оплата через ТОВ Україна (за договором)*",
        `Послуга підпадає під КВЕД — оформлюємо через українське ТОВ.\n\n*Наступні кроки:*\n1. Уточни у контрагента за якими КВЕД він може виставити інвойс\n2. Запроси статутні документи контрагента\n3. Попроси договір у форматі Word\n4. Передай контакт юриста контрагента Вікторії — вона сама все погоджує\n5. Після підписання — створи запит у Titan\n\n👩‍💼 *Вікторія Бобік:*\nSlack: @viktoria.bobik\n📧 viktoria.bobik@gen.tech | Tg: @viktamur\n\nВ копії: anna.kolesnyk@uni.tech, karyne.mnatsakanyan@gen.tech, legal@uni.tech\n\n${TITAN_INSTRUCTIONS}`
      ));
    } else {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `Послуга не підпадає під КВЕД — оплачуємо з грн Mono картки фізособи.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення завчасно через ФОП співробітника.`
      ));
    }
    resetSession(userId);
    return;
  }
}

(async () => {
  await app.start();
  console.log("⚡️ Payment bot v5 is running!");
})();
