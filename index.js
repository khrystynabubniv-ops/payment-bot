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

// --- Links ---
const TITAN_URL = "https://titan.gen.tech/site/login";
const TITAN_NOTION = "https://www.notion.so/Paidlog-Titan-6132cf4d98ae4a33a8dd3f85ad849d85";
const CARDS_NOTION = "https://www.notion.so/18bce9899cb78129a33bfaa08c75a1fb";

// --- Titan instruction block ---
const TITAN_INSTRUCTIONS = `*Як створити запит у Titan:*
1. Відкрий <${TITAN_URL}|Titan> та залогінься
2. Перейди до розділу *Paidlog → Requests*
3. Натисни *"New Request"*
4. Заповни всі поля: отримувач, сума, валюта, призначення
5. Прикріпи *договір* та *інвойс*
6. Відправ на погодження

📖 <${TITAN_NOTION}|Детальна інструкція по Titan>`;

// --- Blocks helpers ---
function sectionBlock(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function actionsBlock(buttons) {
  return {
    type: "actions",
    elements: buttons.map(([label, value, style]) => ({
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      value,
      action_id: `btn_${value}`,
      ...(style ? { style } : {}),
    })),
  };
}

function divider() {
  return { type: "divider" };
}

// Home screen
function homeBlocks() {
  return {
    blocks: [
      sectionBlock("👋 *Привіт! Я допоможу визначити правильний спосіб оплати контрагенту.*\n\nНатисни кнопку нижче щоб почати."),
      actionsBlock([["💳 Провести оплату", "start_payment", "primary"]]),
    ],
  };
}

// Question screen (hides previous by replacing message)
function questionBlocks(text, buttons) {
  return {
    blocks: [
      sectionBlock(text),
      actionsBlock(buttons),
    ],
  };
}

// Result screen
function resultBlocks(title, details, extraBlocks = []) {
  return {
    blocks: [
      sectionBlock(`${title}`),
      divider(),
      sectionBlock(details),
      ...extraBlocks,
      divider(),
      actionsBlock([["🔄 Почати знову", "restart", "primary"]]),
    ],
  };
}

// --- App Home tab ---
app.event("app_home_opened", async ({ event, client }) => {
  const userId = event.user;
  resetSession(userId);
  await client.views.publish({
    user_id: userId,
    view: {
      type: "home",
      blocks: [
        sectionBlock("👋 *Привіт! Я допоможу визначити правильний спосіб оплати контрагенту.*\n\nНатисни кнопку нижче щоб почати."),
        actionsBlock([["💳 Провести оплату", "start_payment", "primary"]]),
      ],
    },
  });
});

// --- Slash command ---
app.command("/payment", async ({ command, ack, client }) => {
  await ack();
  const userId = command.user_id;
  const channelId = command.channel_id;
  resetSession(userId);
  getSession(userId).step = "payment_type";

  const result = await client.chat.postMessage({
    channel: channelId,
    ...questionBlocks(
      "👋 *Визначення способу оплати*\n\nЯкий варіант оплати доступний у контрагента?",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання", "link"],
        ["🌐 Онлайн-підписка", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    ),
  });

  const session = getSession(userId);
  session.channelId = channelId;
  session.ts = result.ts;
});

// --- Button handler ---
app.action(/^btn_/, async ({ action, body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel?.id;
  const ts = body.message?.ts;
  const value = action.value;

  await handleStep(client, userId, channelId, ts, value);
});

// --- Step machine ---
async function handleStep(client, userId, channelId, ts, action) {
  const session = getSession(userId);

  if (action === "restart") {
    resetSession(userId);
    await updateOrPost(client, channelId, ts, questionBlocks(
      "👋 *Визначення способу оплати*\n\nЯкий варіант оплати доступний у контрагента?",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання", "link"],
        ["🌐 Онлайн-підписка", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    ));
    getSession(userId).step = "payment_type";
    return;
  }

  if (action === "start_payment") {
    resetSession(userId);
    const session2 = getSession(userId);
    session2.step = "payment_type";
    const result = await client.chat.postMessage({
      channel: channelId || userId,
      ...questionBlocks(
        "👋 *Визначення способу оплати*\n\nЯкий варіант оплати доступний у контрагента?",
        [
          ["💳 Картка фізособи", "card"],
          ["🖥 Термінал", "terminal"],
          ["🔗 Онлайн-посилання", "link"],
          ["🌐 Онлайн-підписка", "online"],
          ["🏦 Тільки реквізити", "requisites"],
        ]
      ),
    });
    session2.channelId = channelId || userId;
    session2.ts = result.ts;
    return;
  }

  const step = session.step;

  // PAYMENT TYPE
  if (step === "payment_type") {
    session.data.paymentType = action;

    if (["terminal", "link", "online"].includes(action)) {
      await showResult(client, channelId, ts,
        "✅ *Корпоративна картка або картка фізособи*",
        `Термінал, онлайн-посилання та підписки оплачуються:\n• Корпоративною карткою\n• Або грн Mono карткою фізособи\n\n💳 <${CARDS_NOTION}|Реквізити корпоративних карток>`
      );
      resetSession(userId);
      return;
    }

    if (action === "card") {
      session.step = "card_amount";
      await updateOrPost(client, channelId, ts, questionBlocks(
        "💰 *Яка приблизна сума оплати?*",
        [
          ["До 2 500 USD", "low"],
          ["Більше 2 500 USD", "high"],
        ]
      ));
      return;
    }

    if (action === "requisites") {
      session.step = "has_fx";
      await updateOrPost(client, channelId, ts, questionBlocks(
        "🏦 *Уточни у контрагента три речі:*\n\n1️⃣ Чи є валютний рахунок (USD або EUR)?\n2️⃣ Чи може прийняти оплату від іноземної компанії?\n3️⃣ Чи можна вказати у призначенні: реклама, консультації, дизайн або IT?",
        [
          ["✅ Так, всі три — так", "yes"],
          ["❌ Ні, тільки гривня (UAH)", "no"],
        ]
      ));
      return;
    }
  }

  // CARD AMOUNT
  if (step === "card_amount") {
    session.data.amount = action;

    if (action === "high") {
      await showResult(client, channelId, ts,
        "✅ *Запит у Titan — оплата на картку фізособи*",
        `⚠️ Сума перевищує 2 500 USD — *спочатку* напиши Anna Kolesnyk у Slack (@anna.kolesnyk) або на anna.kolesnyk@uni.tech з проханням підтвердити великий платіж на картку.\n\nПісля підтвердження:\n${TITAN_INSTRUCTIONS}\n\n*У коментарях до запиту:* вкажи номер картки та ПІБ отримувача.\n\n💡 Якщо сума значно вища — краще розбити на кілька платежів або різні картки.`
      );
    } else {
      await showResult(client, channelId, ts,
        "✅ *Запит у Titan — оплата на картку фізособи*",
        `${TITAN_INSTRUCTIONS}\n\n*У коментарях до запиту:* вкажи номер картки та ПІБ отримувача.\n\nPayment method: \`CARD\``
      );
    }
    resetSession(userId);
    return;
  }

  // HAS FX
  if (step === "has_fx") {
    session.data.hasFx = action;
    session.step = "contractor";
    await updateOrPost(client, channelId, ts, questionBlocks(
      "🪪 *Хто є отримувачем коштів?*",
      [
        ["ФОП 2 група", "fop2"],
        ["ФОП 3 група", "fop3"],
        ["ТОВ (загальна система)", "tov"],
      ]
    ));
    return;
  }

  // CONTRACTOR
  if (step === "contractor") {
    session.data.contractor = action;

    // ФОП 2 — тільки картка фізособи
    if (action === "fop2") {
      await showResult(client, channelId, ts,
        "✅ *Картка фізособи (грн Mono)*",
        "ФОП 2 групи може приймати оплату тільки від фізосіб.\n\nОплата здійснюється з грн Mono картки, яка поповнюється через ФОП співробітника.\n\n⏰ Плануй поповнення завчасно."
      );
      resetSession(userId);
      return;
    }

    // ФОП 3 або ТОВ — з валютою
    if (session.data.hasFx === "yes" && ["fop3", "tov"].includes(action)) {
      session.step = "service_type";
      await updateOrPost(client, channelId, ts, questionBlocks(
        "📦 *Який тип послуги або товару?*",
        [
          ["📢 Реклама / дизайн / IT / консультації", "neutral"],
          ["🍾 Алкоголь / кейтеринг / розваги / мерч", "catering"],
        ]
      ));
      return;
    }

    // ФОП 3 або ТОВ — тільки гривня → питаємо КВЕД
    if (session.data.hasFx === "no" && ["fop3", "tov"].includes(action)) {
      session.step = "kved_check";
      await updateOrPost(client, channelId, ts, questionBlocks(
        "📋 *Чи підпадає послуга під один із КВЕД?*\n\n• Дизайн\n• Реклама\n• Консультації з бізнесу або IT\n• Оренда локації (конференції, зустрічі)\n• Оренда техніки / обладнання для офісу",
        [
          ["✅ Так, підпадає", "kved_yes"],
          ["❌ Ні, не підпадає", "kved_no"],
        ]
      ));
      return;
    }
  }

  // SERVICE TYPE (валюта)
  if (step === "service_type") {
    session.data.serviceType = action;

    if (action === "neutral") {
      await showResult(client, channelId, ts,
        "✅ *Оплата з нерезидента — запит у Titan*",
        `Попроси контрагента виставити рахунок у *USD або EUR* на:\n*GM Universeapps Limited, Cyprus*\n\n${TITAN_INSTRUCTIONS}`
      );
      resetSession(userId);
      return;
    }

    if (action === "catering") {
      session.step = "can_describe_neutral";
      await updateOrPost(client, channelId, ts, questionBlocks(
        '🔤 *Чи може контрагент описати послугу в інвойсі як одне з:*\n\n• "design services"\n• "organization services"\n• "consulting services"\n• "production of advertising materials"\n\n⚠️ Якщо може написати лише "алкоголь", "сумки", "худі" — цей метод не підійде.',
        [
          ["✅ Так, може", "yes"],
          ["❌ Ні, тільки прямий опис", "no"],
        ]
      ));
      return;
    }
  }

  // CAN DESCRIBE NEUTRAL
  if (step === "can_describe_neutral") {
    if (action === "yes") {
      await showResult(client, channelId, ts,
        "✅ *Оплата з нерезидента — запит у Titan*",
        `Контрагент вказує нейтральний опис у інвойсі (наприклад "organization services").\n\nПопроси виставити рахунок у *USD або EUR* на:\n*GM Universeapps Limited, Cyprus*\n\n${TITAN_INSTRUCTIONS}`
      );
    } else {
      await showResult(client, channelId, ts,
        "⛔ *Оплата з нерезидента неможлива*",
        "Контрагент не може вказати нейтральний опис — цей метод не підходить.\n\nЗверніться до Finance&Legal або юриста Вікторії:\n📧 viktoria.bobik@gen.tech | Tg: @viktamur"
      );
    }
    resetSession(userId);
    return;
  }

  // KVED CHECK (гривня, ФОП 3 або ТОВ)
  if (step === "kved_check") {
    if (action === "kved_yes") {
      await showResult(client, channelId, ts,
        "✅ *Оплата через ТОВ Україна (за договором)*",
        `Послуга підпадає під КВЕД — можемо оформити через українське ТОВ.\n\n*Наступні кроки:*\n1. Дізнайся за якими КВЕД контрагент може виставити інвойс\n2. Запроси статутні документи контрагента\n3. Попроси договір у форматі Word\n4. Передай все юристу Вікторії — вона сама комунікує з контрагентом\n5. Після підписання — створи запит у Titan\n\n👩‍💼 *Вікторія Бобік:*\nSlack: @viktoria.bobik\n📧 viktoria.bobik@gen.tech | admin.legal@gen.tech\nTg: @viktamur\n\nВ копії листа: anna.kolesnyk@uni.tech, karyne.mnatsakanyan@gen.tech, legal@uni.tech\n\n${TITAN_INSTRUCTIONS}`
      );
    } else {
      await showResult(client, channelId, ts,
        "✅ *Картка фізособи (грн Mono)*",
        "Послуга не підпадає під КВЕД — оплачуємо з грн Mono картки фізособи, яка поповнюється через ФОП співробітника.\n\n⏰ Плануй поповнення завчасно."
      );
    }
    resetSession(userId);
    return;
  }
}

// --- Helpers ---
async function updateOrPost(client, channelId, ts, payload) {
  try {
    if (ts && channelId) {
      await client.chat.update({ channel: channelId, ts, ...payload });
    } else {
      await client.chat.postMessage({ channel: channelId, ...payload });
    }
  } catch {
    await client.chat.postMessage({ channel: channelId, ...payload });
  }
}

async function showResult(client, channelId, ts, title, details) {
  await updateOrPost(client, channelId, ts, resultBlocks(title, details));
}

// --- Start ---
(async () => {
  await app.start();
  console.log("⚡️ Payment bot v2 is running!");
})();
