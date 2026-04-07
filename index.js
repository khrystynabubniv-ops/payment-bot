const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// --- State storage (in-memory, per user) ---
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: "start", data: {} };
  return sessions[userId];
}

function resetSession(userId) {
  sessions[userId] = { step: "start", data: {} };
}

// --- Decision logic ---
function getResult(data) {
  const { paymentType, contractor, serviceType, hasFx, canDescribeNeutral, amount } = data;

  // Terminal / online link / online service
  if (["terminal", "link", "online"].includes(paymentType)) {
    return {
      result: "✅ *Корпоративна картка* або *картка фізособи*",
      details:
        "Термінал, онлайн-посилання та підписки можна оплатити корпоративною карткою або грн Mono карткою фізособи.",
      action: null,
    };
  }

  // Card of individual
  if (paymentType === "card") {
    if (amount === "high") {
      return {
        result: "✅ *Запит у Titan* (оплата на картку фізособи)",
        details:
          "Сума перевищує 2 500 USD — *спочатку* напишіть anna.kolesnyk@uni.tech. Потім створіть запит у Titan: `Payment method: CARD`, вкажіть номер картки та ПІБ у коментарях. Якщо сума значно вища — краще розбити на кілька платежів або різні картки.",
        action: "📧 Написати: anna.kolesnyk@uni.tech",
      };
    }
    return {
      result: "✅ *Запит у Titan* (оплата на картку фізособи)",
      details:
        "Створіть запит у Titan: `Payment method: CARD`, вкажіть номер картки та ПІБ у коментарях.\nhttps://titan.gen.tech/paidlog/requests",
      action: null,
    };
  }

  // Requisites only
  if (paymentType === "requisites") {
    // Has FX account — foreign company possible
    if (hasFx === "yes") {
      if (["fop3", "tov"].includes(contractor)) {
        if (serviceType === "neutral") {
          return {
            result: "✅ *Оплата з нерезидента* — запит у Titan",
            details:
              "Виставте рахунок у USD або EUR на *GM Universeapps Limited, Cyprus*. Прикріпіть інвойс і договір у Titan.\nhttps://titan.gen.tech/paidlog/requests\n\n📎 Шаблон інвойсу: попросіть в юриста або використайте власний шаблон контрагента.",
            action: null,
          };
        }
        if (serviceType === "catering") {
          if (canDescribeNeutral === "yes") {
            return {
              result: "✅ *Оплата з нерезидента* — запит у Titan",
              details:
                'Контрагент може описати послугу як "design services / organization services / consulting services" — це ок. Виставте рахунок у USD/EUR на GM Universeapps Limited. Прикріпіть інвойс і договір у Titan.\nhttps://titan.gen.tech/paidlog/requests',
              action: null,
            };
          } else {
            return {
              result: "⛔ *Оплата з нерезидента неможлива*",
              details:
                "Контрагент не може вказати нейтральний опис послуги — цей метод не підходить. Оберіть інший спосіб оплати: картка фізособи або ТОВ Україна (якщо послуга підходить під КВЕД).",
              action: null,
            };
          }
        }
      }
    }

    // UAH only
    if (hasFx === "no") {
      if (contractor === "fop2") {
        return {
          result: "✅ *Картка фізособи* (грн Mono)",
          details:
            "ФОП 2 групи може приймати оплату тільки від фізосіб. Платимо з грн картки, яка поповнюється через ФОП співробітника. Плануйте поповнення завчасно.",
          action: null,
        };
      }

      if (["fop3", "tov"].includes(contractor)) {
        // Will be asked for sub-method — this path handled via step "uah_method"
        return { result: "__uah_multi__" };
      }
    }
  }

  return {
    result: "❓ Не вдалося визначити метод",
    details: "Зверніться до Finance&Legal (Universe Group) або юриста Вікторії: viktoria.bobik@gen.tech",
    action: null,
  };
}

// --- Message builder ---
function buildResult(res) {
  let text = `\n${res.result}\n\n${res.details}`;
  if (res.action) text += `\n\n${res.action}`;
  text += "\n\n---\nЩоб почати знову — натисни кнопку нижче.";
  return text;
}

// --- Slack Block Kit helpers ---
function questionBlock(text, buttons) {
  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: buttons.map(([label, value, style]) => ({
          type: "button",
          text: { type: "plain_text", text: label },
          value,
          action_id: `btn_${value}`,
          ...(style ? { style } : {}),
        })),
      },
    ],
  };
}

function resultBlock(text) {
  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔄 Почати знову" },
            value: "restart",
            action_id: "btn_restart",
            style: "primary",
          },
        ],
      },
    ],
  };
}

// --- Step handler ---
async function handleStep(client, userId, channelId, ts, action) {
  const session = getSession(userId);

  // RESTART
  if (action === "restart") {
    resetSession(userId);
    await sendStep(client, userId, channelId, ts);
    return;
  }

  // Store answer and advance
  const step = session.step;

  if (step === "start") {
    session.step = "payment_type";
  } else if (step === "payment_type") {
    session.data.paymentType = action;
    if (action === "requisites") {
      session.step = "has_fx";
    } else if (action === "card") {
      session.step = "card_amount";
    } else {
      // terminal / link / online → result
      session.step = "result";
    }
  } else if (step === "card_amount") {
    session.data.amount = action;
    session.step = "result";
  } else if (step === "has_fx") {
    session.data.hasFx = action;
    session.step = "contractor";
  } else if (step === "contractor") {
    session.data.contractor = action;
    if (session.data.hasFx === "yes" && ["fop3", "tov"].includes(action)) {
      session.step = "service_type";
    } else if (session.data.hasFx === "no" && ["fop3", "tov"].includes(action)) {
      session.step = "uah_method";
    } else {
      session.step = "result";
    }
  } else if (step === "service_type") {
    session.data.serviceType = action;
    if (action === "catering") {
      session.step = "can_describe_neutral";
    } else {
      session.step = "result";
    }
  } else if (step === "can_describe_neutral") {
    session.data.canDescribeNeutral = action;
    session.step = "result";
  } else if (step === "uah_method") {
    session.data.uahMethod = action;
    session.step = "uah_result";
  }

  await sendStep(client, userId, channelId, ts);
}

async function sendStep(client, userId, channelId, ts) {
  const session = getSession(userId);
  const step = session.step;
  const data = session.data;

  let payload;

  if (step === "start" || step === "payment_type") {
    payload = questionBlock(
      "👋 *Визначення способу оплати контрагенту*\n\nЯкий варіант оплати доступний у контрагента?",
      [
        ["💳 Картка фізособи", "card"],
        ["🖥 Термінал", "terminal"],
        ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
        ["🌐 Онлайн-підписка (сервіс)", "online"],
        ["🏦 Тільки реквізити", "requisites"],
      ]
    );
  } else if (step === "card_amount") {
    payload = questionBlock("💰 Яка приблизна сума оплати?", [
      ["До 2 500 USD", "low"],
      ["Більше 2 500 USD", "high"],
    ]);
  } else if (step === "has_fx") {
    payload = questionBlock(
      "🏦 Оплата лише по реквізитах. Уточни у контрагента:\n\n• Чи є *валютний рахунок* (USD або EUR)?\n• Чи може прийняти оплату від *іноземної компанії*?\n• Чи можна вказати у призначенні: реклама, консультації, дизайн, IT?",
      [
        ["✅ Так, все підходить", "yes"],
        ["❌ Ні, тільки гривня (UAH)", "no"],
      ]
    );
  } else if (step === "contractor") {
    payload = questionBlock("🪪 Хто є отримувачем коштів?", [
      ["ФОП 2 група", "fop2"],
      ["ФОП 3 група", "fop3"],
      ["ТОВ (загальна система)", "tov"],
    ]);
  } else if (step === "service_type") {
    payload = questionBlock(
      "📦 Який тип послуги/товару?",
      [
        ["Реклама / дизайн / IT / консультації", "neutral"],
        ["Алкоголь / кейтеринг / розваги / мерч", "catering"],
      ]
    );
  } else if (step === "can_describe_neutral") {
    payload = questionBlock(
      '🔤 Контрагент може описати послугу в інвойсі як:\n_"design services", "organization services", "consulting services", "production of advertising materials"_?\n\n⚠️ Якщо ні і може вказати лише "алкоголь", "сумки", "худі" — цей метод не підійде.',
      [
        ["✅ Так, може", "yes"],
        ["❌ Ні, тільки прямий опис товару", "no"],
      ]
    );
  } else if (step === "uah_method") {
    payload = questionBlock(
      `📋 ФОП 3 / ТОВ (загальна) — оплата в гривні. Обери зручний метод:`,
      [
        ["💳 Картка фізособи (Mono грн)", "card_phys"],
        ["🌍 Нерезидент (USD/EUR через Titan)", "nonresident"],
        ["🏢 ТОВ Україна (за договором)", "tov_ua"],
      ]
    );
  } else if (step === "uah_result") {
    const method = data.uahMethod;
    let res;
    if (method === "card_phys") {
      res = {
        result: "✅ *Картка фізособи* (грн Mono)",
        details:
          "Оплата з грн картки, яка поповнюється через ФОП співробітника. Плануйте поповнення завчасно.",
      };
    } else if (method === "nonresident") {
      res = {
        result: "✅ *Оплата з нерезидента* — запит у Titan",
        details:
          "Виставте рахунок у USD або EUR на *GM Universeapps Limited, Cyprus*. Прикріпіть інвойс і договір.\nhttps://titan.gen.tech/paidlog/requests",
      };
    } else if (method === "tov_ua") {
      res = {
        result: "✅ *Оплата через ТОВ Україна*",
        details:
          "Перевірте, чи послуга підпадає під КВЕД (дизайн, реклама, консультації, оренда, IT).\n\nЯкщо так:\n1. Запросіть статутні документи контрагента → юристу Вікторії\n2. Попросіть договір у форматі Word → юристу на перевірку\n3. Після підписання — запит у Titan з договором та інвойсом\n\n📧 Вікторія: viktoria.bobik@gen.tech | Tg: @viktamur",
      };
    }
    payload = resultBlock(buildResult(res));
    resetSession(userId);
    await client.chat.update({ channel: channelId, ts, ...payload });
    return;
  } else if (step === "result") {
    const res = getResult(data);
    if (res.result === "__uah_multi__") {
      session.step = "uah_method";
      await sendStep(client, userId, channelId, ts);
      return;
    }
    payload = resultBlock(buildResult(res));
    resetSession(userId);
    await client.chat.update({ channel: channelId, ts, ...payload });
    return;
  }

  try {
    if (ts) {
      await client.chat.update({ channel: channelId, ts, ...payload });
    } else {
      await client.chat.postMessage({ channel: channelId, ...payload });
    }
  } catch (e) {
    await client.chat.postMessage({ channel: channelId, ...payload });
  }
}

// --- Slash command: /payment ---
app.command("/payment", async ({ command, ack, client }) => {
  await ack();
  const userId = command.user_id;
  const channelId = command.channel_id;
  resetSession(userId);
  const session = getSession(userId);
  session.step = "payment_type";

  const payload = questionBlock(
    "👋 *Визначення способу оплати контрагенту*\n\nЯкий варіант оплати доступний у контрагента?",
    [
      ["💳 Картка фізособи", "card"],
      ["🖥 Термінал", "terminal"],
      ["🔗 Онлайн-посилання (Liqpay і т.д)", "link"],
      ["🌐 Онлайн-підписка (сервіс)", "online"],
      ["🏦 Тільки реквізити", "requisites"],
    ]
  );

  const result = await client.chat.postMessage({ channel: channelId, ...payload });
  session.ts = result.ts;
  session.channelId = channelId;
});

// --- Handle all button clicks ---
app.action(/^btn_/, async ({ action, body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel.id;
  const ts = body.message.ts;
  const value = action.value;

  await handleStep(client, userId, channelId, ts, value);
});

// --- Start ---
(async () => {
  await app.start();
  console.log("⚡️ Payment bot is running!");
})();
