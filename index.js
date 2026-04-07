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

const TITAN_INSTRUCTIONS = `*Як створити запит у Titan:*
1. Відкрий <${TITAN_URL}|Titan> та залогінься
2. Перейди до *Paidlog → Requests*
3. Натисни *"New Request"*
4. Заповни: отримувач, сума, валюта, призначення
5. Прикріпи *договір* та *інвойс*
6. Відправ на погодження

📖 <${TITAN_NOTION}|Детальна інструкція по Titan>`;

function s(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}
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

function resultMsg(title, details) {
  return {
    blocks: [
      s(title),
      divider(),
      s(details),
      divider(),
      actions([["🔄 Почати знову", "restart", "primary"]]),
    ],
  };
}

// Home tab
app.event("app_home_opened", async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          s("👋 *Привіт! Я допоможу визначити правильний спосіб оплати контрагенту.*\n\nНатисни кнопку нижче — і я крок за кроком підкажу який метод обрати."),
          actions([["💳 Провести оплату", "start_payment", "primary"]]),
        ],
      },
    });
  } catch (e) { console.error("Home error:", e?.data || e); }
});

// Slash command
app.command("/payment", async ({ command, ack, client }) => {
  await ack();
  const userId = command.user_id;
  resetSession(userId);
  getSession(userId).step = "payment_type";
  const r = await client.chat.postMessage({
    channel: command.channel_id,
    ...questionMsg(
      "👋 *Визначення способу оплати*\n\nОбери варіант оплати, який доступний у контрагента — і я підкажу що робити далі:",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
        ["🌐 Онлайн-підписка", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    ),
  });
  const sess = getSession(userId);
  sess.channelId = command.channel_id;
  sess.ts = r.ts;
});

// Button clicks
app.action(/^btn_/, async ({ action, body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel?.id;
  const ts = body.message?.ts;
  const value = action.value;
  const label = action.text?.text || value;

  // Hide buttons — show what was selected
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
  const r = await client.chat.postMessage({ channel: channelId, ...payload });
  return r.ts;
}

async function handleStep(client, userId, channelId, action) {
  const session = getSession(userId);

  if (action === "restart") {
    resetSession(userId);
    getSession(userId).step = "payment_type";
    await post(client, channelId, questionMsg(
      "👋 *Визначення способу оплати*\n\nОбери варіант оплати, який доступний у контрагента — і я підкажу що робити далі:",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
        ["🌐 Онлайн-підписка", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    ));
    return;
  }

  if (action === "start_payment") {
    resetSession(userId);
    getSession(userId).step = "payment_type";
    await post(client, channelId || userId, questionMsg(
      "👋 *Визначення способу оплати*\n\nОбери варіант оплати, який доступний у контрагента — і я підкажу що робити далі:",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
        ["🌐 Онлайн-підписка", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    ));
    return;
  }

  const step = session.step;

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
      session.step = "card_amount";
      await post(client, channelId, questionMsg(
        "💰 *Яка приблизна сума оплати?*\n\nВід цього залежить чи потрібне додаткове погодження:",
        [["До 2 500 USD", "low"], ["Більше 2 500 USD", "high"]]
      ));
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

  if (step === "card_amount") {
    session.data.amount = action;
    if (action === "high") {
      await post(client, channelId, resultMsg(
        "✅ *Запит у Titan — оплата на картку фізособи*",
        `⚠️ Сума перевищує 2 500 USD — *спочатку* напиши Ані Колесник у Slack (@anna.kolesnyk) або anna.kolesnyk@uni.tech.\n\n*Навіщо?* Великі платежі на картку можуть викликати питання від банку — Аня погоджує і за потреби координує розбивку платежу.\n\nПісля підтвердження:\n${TITAN_INSTRUCTIONS}\n\n*У коментарях:* номер картки та ПІБ отримувача.\n\n💡 Якщо сума значно вища — краще розбити на кілька платежів або різні картки.`
      ));
    } else {
      await post(client, channelId, resultMsg(
        "✅ *Запит у Titan — оплата на картку фізособи*",
        `${TITAN_INSTRUCTIONS}\n\n*У коментарях до запиту:* вкажи номер картки та ПІБ отримувача.\nPayment method: \`CARD\``
      ));
    }
    resetSession(userId);
    return;
  }

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

  if (step === "contractor") {
    session.data.contractor = action;

    if (action === "fop2") {
      await post(client, channelId, resultMsg(
        "✅ *Картка фізособи (грн Mono)*",
        `ФОП 2 групи може приймати оплату тільки від фізосіб — тому платимо з грн Mono картки.\n\n💳 <${CARDS_NOTION}|Реквізити карток фізосіб>\n\n⏰ Плануй поповнення картки завчасно через ФОП співробітника.`
      ));
      resetSession(userId);
      return;
    }

    if (session.data.hasFx === "yes" && ["fop3", "tov"].includes(action)) {
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

    if (session.data.hasFx === "no" && ["fop3", "tov"].includes(action)) {
      session.step = "kved_check";
      await post(client, channelId, questionMsg(
        "📋 *Чи підпадає послуга під один із КВЕД?*\n\nНаші ТОВ можуть оплачувати лише ці типи послуг:\n• Дизайн\n• Реклама\n• Консультації з бізнесу або IT\n• Оренда локації (конференції, зустрічі)\n• Оренда техніки / обладнання для офісу\n\nОбери варіант який найбільше підходить:",
        [["✅ Так, підпадає", "kved_yes"], ["❌ Ні, не підпадає", "kved_no"]]
      ));
      return;
    }
  }

  if (step === "service_type") {
    session.data.serviceType = action;

    if (action === "neutral") {
      await post(client, channelId, resultMsg(
        "✅ *Оплата з нерезидента — запит у Titan*",
        `Попроси контрагента виставити рахунок у *USD або EUR* на:\n*GM Universeapps Limited, Cyprus*\n\n${TITAN_INSTRUCTIONS}`
      ));
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

  if (step === "can_describe_neutral") {
    if (action === "yes") {
      await post(client, channelId, resultMsg(
        "✅ *Оплата з нерезидента — запит у Titan*",
        `Контрагент вказує нейтральний опис у інвойсі (наприклад "organization services").\n\nПопроси виставити рахунок у *USD або EUR* на:\n*GM Universeapps Limited, Cyprus*\n\n${TITAN_INSTRUCTIONS}`
      ));
    } else {
      await post(client, channelId, resultMsg(
        "⛔ *Оплата з нерезидента неможлива*",
        "Контрагент не може вказати нейтральний опис — цей метод не підходить.\n\nЗверніться до юриста Вікторії — вона підкаже альтернативу:\n📧 viktoria.bobik@gen.tech | Tg: @viktamur"
      ));
    }
    resetSession(userId);
    return;
  }

  if (step === "kved_check") {
    if (action === "kved_yes") {
      await post(client, channelId, resultMsg(
        "✅ *Оплата через ТОВ Україна (за договором)*",
        `Послуга підпадає під КВЕД — оформлюємо через українське ТОВ.\n\n*Наступні кроки:*\n1. Уточни у контрагента за якими КВЕД він може виставити інвойс\n2. Запроси статутні документи контрагента\n3. Попроси договір у форматі Word\n4. Передай контакт юриста контрагента Вікторії — вона сама все погоджує\n5. Після підписання — створи запит у Titan\n\n👩‍💼 *Вікторія Бобік:*\nSlack: @viktoria.bobik\n📧 viktoria.bobik@gen.tech\nTg: @viktamur\n\nВ копії листа: anna.kolesnyk@uni.tech, karyne.mnatsakanyan@gen.tech, legal@uni.tech\n\n${TITAN_INSTRUCTIONS}`
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
  console.log("⚡️ Payment bot v3 is running!");
})();
