// ==UserScript==
// @name         WCAIR - Web Chat AI Resumer
// @namespace    chat-resume
// @version      2.11.5
// @description  Экспорт сообщений из чатов MAX/VK и резюме через ИИ
// @match        https://web.max.ru/*
// @match        https://vk.ru/*
// @updateURL    http://localhost:3000/wcair.user.js
// @downloadURL  http://localhost:3000/wcair.user.js
// @grant        unsafeWindow
// @grant        GM.xmlHttpRequest
// @grant        GM.setClipboard
// @grant        GM_registerMenuCommand
// @connect      dashscope-intl.aliyuncs.com
// @connect      dashscope.aliyuncs.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @run-at       document-start
// @license      MIT
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  // ------------------------------------------------------------------
  // ОПРЕДЕЛЕНИЕ САЙТА
  // ------------------------------------------------------------------
  var hostname = window.location.hostname;
  var isMax = hostname === 'web.max.ru';
  var isVK = hostname === 'vk.ru';
  var site = isMax ? 'max' : isVK ? 'vk' : null;

  if (!site) {
    return;
  }

  // ------------------------------------------------------------------
  // VK-специфичные константы
  // ------------------------------------------------------------------
  var VK_TIMEOUT = 30000;
  var BRIDGE_NAME = 'vk-exporter-bridge';
  var bridgeRequests = {};

  // ------------------------------------------------------------------
  // НАСТРОЙКИ DOM-Скрейпинга для web.max.ru
  // ------------------------------------------------------------------
  // Сообщения в MAX отрисовываются на клиенте (SvelteKit, виртуальный
  // список), внутреннего API вида window.vkApi нет. Поэтому текст
  // сообщений читается напрямую из отрисованного DOM.
  //
  // Селекторы ниже можно уточнить после запуска команды:
  //   window.__maxAirInspect()
  // в консоли браузера на открытой беседе. Если селектор пустой - для
  // соответствующего поля будет использоваться автоопределение.
  var DOM_CONF = {
    composerSelector: '[data-testid="composer"]',
    scrollContainerSelector: '.scrollable.scrollListScrollable',
    messageRowSelector: '.item[data-index]',
    messageAuthorSelector: '.bubbleContent .header .name .text',
    messageTimeSelector: '.bubbleContent .meta .text',
    messageTextSelector: '.bubbleContent > .text',
    dateSelector: '.capsuleSeparator .capsule',
    // Блок "ответ на сообщение": кнопка с автором цитируемого и цитатой.
    replyBlockSelector: '.link button.mark',
    replyAuthorSelector: '.author .name .text'
  };

  // ------------------------------------------------------------------
  // VK-специфичные функции (мост для работы с VK API)
  // ------------------------------------------------------------------
  function installVkBridge() {
    if (!isVK) return;

    var bridge = function(name) {
      if (window.__vkExporterBridgeInstalled) {
        return;
      }

      window.__vkExporterBridgeInstalled = true;

      window.addEventListener('message', function(event) {
        var request = event.data;

        if (
          !request ||
          request.type !== name + ':request'
        ) {
          return;
        }

        var response = {
          type: name + ':response',
          id: request.id
        };

        try {
          if (
            !window.vkApi ||
            typeof window.vkApi.api !== 'function'
          ) {
            response.error = 'VK API недоступен';
            window.postMessage(response, '*');
            return;
          }

          var apiResult = window.vkApi.api(
            'messages.getHistory',
            request.params
          );

          if (
            !apiResult ||
            typeof apiResult.then !== 'function'
          ) {
            response.error =
              'VK API не вернул Promise';
            window.postMessage(response, '*');
            return;
          }

          apiResult.then(
            function(result) {
              try {
                response.payload = JSON.stringify(result);
              } catch (error) {
                response.error =
                  'Не удалось сериализовать ответ VK: ' +
                  error.message;
              }

              window.postMessage(response, '*');
            },
            function(error) {
              response.error = error && error.message
                ? error.message
                : String(error);

              window.postMessage(response, '*');
            }
          );
        } catch (error) {
          response.error = error && error.message
            ? error.message
            : String(error);

          window.postMessage(response, '*');
        }
      });
    };

    var script = document.createElement('script');

    script.textContent =
      '(' +
      bridge.toString() +
      ')(' +
      JSON.stringify(BRIDGE_NAME) +
      ');';

    var parent = document.documentElement ||
      document.head ||
      document.body;

    if (parent) {
      parent.appendChild(script);
      script.remove();
    }
  }

  function installBridgeListener() {
    if (!isVK) return;

    window.addEventListener('message', function(event) {
      var response = event.data;

      if (
        !response ||
        response.type !== BRIDGE_NAME + ':response'
      ) {
        return;
      }

      var request = bridgeRequests[response.id];

      if (!request) {
        return;
      }

      delete bridgeRequests[response.id];

      if (response.error) {
        request.reject(new Error(response.error));
        return;
      }

      try {
        request.resolve(JSON.parse(response.payload));
      } catch (error) {
        request.reject(error);
      }
    });
  }

  function requestVkHistory(params) {
    return new Promise(function(resolve, reject) {
      var id =
        Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2);

      var timer = setTimeout(function() {
        delete bridgeRequests[id];

        reject(
          new Error(
            'VK API не ответил за ' +
            VK_TIMEOUT / 1000 +
            ' секунд.'
          )
        );
      }, VK_TIMEOUT);

      bridgeRequests[id] = {
        resolve: function(value) {
          clearTimeout(timer);
          resolve(value);
        },

        reject: function(error) {
          clearTimeout(timer);
          reject(error);
        }
      };

      window.postMessage({
        type: BRIDGE_NAME + ':request',
        id: id,
        params: params
      }, '*');
    });
  }

  function loadMessagesFromVkApi(peerId, limit, targetDate) {
    var messages = [];
    var seenIds = {};
    var lastId = null;
    var finished = false;

    showStatus('Загрузка сообщений...');
    loadPage();

    function loadPage() {
      if (finished) {
        return;
      }

      var params = {
        peer_id: peerId,
        count: 200,
        extended: 1
      };

      if (lastId !== null) {
        params.start_message_id = lastId;
      }

      requestVkHistory(params)
        .then(processPage)
        .catch(function(error) {
          finishWithError(
            'Ошибка загрузки сообщений VK:\n\n' +
            error.message
          );
        });
    }

    function processPage(result) {
      var items = result && result.items
        ? result.items
        : [];

      var profiles = result && result.profiles
        ? result.profiles
        : [];

      if (!Array.isArray(items)) {
        finishWithError(
          'VK API вернул некорректный ответ.'
        );
        return;
      }

      if (items.length === 0) {
        finish();
        return;
      }

      for (var i = 0; i < items.length; i++) {
        var item = items[i];

        if (targetDate && item.date < targetDate) {
          finish();
          return;
        }

        if (seenIds[item.id]) {
          continue;
        }

        seenIds[item.id] = true;

        if (!item.text || !item.text.trim()) {
          continue;
        }

        var profile = profiles.find(function(user) {
          return user.id === item.from_id;
        });

        var name = profile
          ? profile.first_name + ' ' + profile.last_name
          : 'ID' + item.from_id;

        var date = new Date(item.date * 1000);
        var dateText = date.toLocaleDateString('ru-RU');
        var timeText = date.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit'
        });

        var replyPrefix = item.reply_message
          ? formatVkReplyPrefix(item.reply_message, profiles)
          : '';

        messages.push({
          id: item.id,
          date: item.date,
          text:
            replyPrefix +
            '[' + dateText + ' ' + timeText + '] ' +
            name + ':\n' +
            item.text
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n')
              .trim()
        });
      }

      showStatus(
        'Загружено сообщений: ' + messages.length
      );

      if (
        !targetDate &&
        messages.length >= limit
      ) {
        finish();
        return;
      }

      if (items.length < 200) {
        finish();
        return;
      }

      lastId = items[items.length - 1].id;

      if (!lastId) {
        finish();
        return;
      }

      setTimeout(loadPage, 300);
    }

    function finish() {
      if (finished) {
        return;
      }

      finished = true;
      removeElement('maxair-status');

      messages.sort(function(first, second) {
        return first.date - second.date ||
          first.id - second.id;
      });

      var selected = targetDate
        ? messages
        : messages.slice(-limit);

      if (!selected.length) {
        alert('Сообщения не найдены');
        return;
      }

      var text = selected.map(function(message) {
        return message.text;
      }).join('\n\n---\n\n');

      showPromptMenu(
        text,
        selected.length,
        formatSamplingPeriod(selected)
      );
    }

    function finishWithError(message) {
      if (finished) {
        return;
      }

      finished = true;
      removeElement('maxair-status');
      alert(message);
      console.error(message);
    }
  }

  function formatVkReplyPrefix(replyMessage, profiles) {
    var replyDate = new Date(replyMessage.date * 1000);
    var replyDateText = replyDate.toLocaleDateString('ru-RU');
    var replyTimeText = replyDate.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
    var replyProfile = profiles.find(function(user) {
      return user.id === replyMessage.from_id;
    });
    var replyName = replyProfile
      ? replyProfile.first_name + ' ' + replyProfile.last_name
      : 'ID' + replyMessage.from_id;

    return 'Ответ на сообщение [' +
      replyDateText + ' ' +
      replyTimeText + '] ' +
      replyName + ':\n';
  }

  function isVkChatOpen() {
    return /\/im\/convo\/\d+/.test(
      window.location.pathname
    );
  }

  // ------------------------------------------------------------------
  // ИИ-провайдеры
  // ------------------------------------------------------------------
  var sitePrefix = isMax ? 'maxair' : 'vk-exporter';

  var PROVIDERS = {
    qwen: {
      name: 'Qwen Cloud',
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus',
      cookieKey: sitePrefix + '-qwen-api-key'
    },
    openrouter: {
      name: 'OpenRouter (free)',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      cookieKey: sitePrefix + '-openrouter-api-key'
    },
    openrouter_nemotron: {
      name: 'OpenRouter (Nemotron 3 Ultra)',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      cookieKey: sitePrefix + '-openrouter-api-key'
    }
  };

  var DEFAULT_PROVIDER = 'qwen';
  var PROVIDER_STORAGE_KEY = sitePrefix + '-selected-provider';
  var CUSTOM_PROMPT_STORAGE_KEY = sitePrefix + '-custom-prompt';
  var MAX_CHARS = 60000;
  var AI_TIMEOUT = 120000;
  var PROMPT_TEMPLATES = {
    allEvents:
      'Действуй как эксперт по анализу текстовых коммуникаций и структурированию информации. ' +
      'Твоя задача: обрабатывать большие объемы переписок (рабочих чатов, домовых чатов, личных диалогов) ' +
      'и выдавать сжатое, структурированное резюме.\n\n' +
      'Правила обработки и вывода:\n\n' +
      '    Строгий старт: Начинай ответ немедленно с самого резюме. Категорически запрещены любые ' +
      'вступительные фразы («Я проанализировал чат», «Вот краткое содержание», «Конечно, держи резюме»).\n' +
      '    Фильтрация шума: Полностью игнорируй приветствия, прощания, оффтоп, флуд, бессмысленные реакции ' +
      'и малозначимые детали, не влияющие на суть обсуждений.\n' +
      '    Структура по темам: Группируй информацию по ключевым темам или проблемам, которые поднимались в чате. ' +
      'Используй четкие заголовки.\n' +
      '    Визуализация: Системно используй эмодзи для навигации и акцентов (например: 📌 для главной темы, ' +
      '💬 для контекста/обсуждения, ✅ для принятых решений, ⚠️ для проблем/нерешенных вопросов, ' +
      '👤 для ответственных, 📅 для сроков).\n' +
      '    Блок действий: Если в чате есть задачи, поручения или договоренности, обязательно выноси их в ' +
      'отдельный блок «Договоренности и задачи» с указанием, кто и что должен сделать.\n' +
      '    Фактологичность: Сохраняй точность, не додумывай контекст, если его нет в предоставленном тексте.\n\n' +
      'Сообщения из чата:\n\n{{TEXT}}',
    importantOnly:
      'Действуй как эксперт по анализу текстовых коммуникаций и приоритизации информации. ' +
      'Твоя задача: обрабатывать большие объемы переписок и выделять только критически важные моменты, ' +
      'отсекая всё остальное.\n\n' +
      'Правила обработки и вывода:\n\n' +
      '    Строгий старт: Начинай ответ немедленно с самого резюме. Категорически запрещены любые ' +
      'вступительные фразы («Я проанализировал чат», «Вот краткое содержание»).\n' +
      '    Жесткий фильтр важности: В резюме попадают ТОЛЬКО:\n' +
      '        Принятые решения и договоренности\n' +
      '        Конкретные задачи с назначенными исполнителями и сроками\n' +
      '        Критические проблемы, требующие немедленного внимания\n' +
      '        Важные новости, меняющие ситуацию (отмены, изменения планов, ЧП)\n' +
      '        Финансовые вопросы и обязательства\n' +
      '    Игнорировать полностью: Обсуждения без результата, споры, предложения без решения, ' +
      'контекст, детали реализации, приветствия, флуд.\n\n' +
      '    Визуализация: Используй эмодзи для упрощения восприятия текста у глаголов и абзацев.\n' +
      '    Краткость: Пиши максимально сжато, только факты. Если момент можно описать одной строкой — ' +
      'не пиши две.\n' +
      '    Фактологичность: Не додумывай, не добавляй контекст, которого нет в тексте.\n\n' +
      'Сообщения из чата:\n\n{{TEXT}}'
  };

  var pageWindow = typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : window;

  // Известные служебные маршруты MAX, не являющиеся беседой
  var KNOWN_ROUTES = [
    'joincall', 'join', 'stickerset', 'u', 'c',
    'settings', 'push', 'folder', 'share', 'share-self-out',
    '_storybook', 'undefined'
  ];

  // document-start: body может ещё не существовать, ждём его
  var bodyInitDone = false;
  function initBodyDependent() {
    if (bodyInitDone) { return; }
    if (!document.body && !document.documentElement) { return; }
    bodyInitDone = true;

    if (isVK) {
      installVkBridge();
      installBridgeListener();
    }

    createLauncher();
    setInterval(updateLauncherVisibility, 500);
    watchUrlChanges();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand(
        'Запустить экспорт сообщений',
        startExporter
      );
    }
  }
  document.addEventListener('DOMContentLoaded', initBodyDependent);
  if (document.readyState !== 'loading') {
    initBodyDependent();
  } else {
    setInterval(initBodyDependent, 200);
  }

  // MAX - одностраничное приложение (SvelteKit): при переключении бесед
  // DOM пересобирается без перезагрузки страницы. Следим за сменой URL
  // и сбрасываем устаревшие элементы интерфейса и состояние контейнера.
  var lastUrl = pageWindow.location.href;

  function watchUrlChanges() {
    setInterval(function() {
      if (pageWindow.location.href !== lastUrl) {
        lastUrl = pageWindow.location.href;
        onUrlChanged();
      }
    }, 400);
  }

  function onUrlChanged() {
    removeElement('maxair-mode-menu');
    removeElement('maxair-menu');
    removeElement('maxair-prompt-menu');
    removeElement('maxair-status');
    removeElement('maxair-result');

    updateLauncherVisibility();
  }

  // ------------------------------------------------------------------
  // Определение открытой беседы MAX
  // ------------------------------------------------------------------
  function getCurrentChatId() {
    var path = pageWindow.location.pathname.replace(/^\/+|\/+$/g, '');
    var segments = path.split('/').filter(function(s) { return s; });

    if (segments.length < 1) {
      return null;
    }

    var first = segments[0];

    if (KNOWN_ROUTES.indexOf(first) !== -1) {
      return null;
    }

    return first;
  }

  function isChatOpen() {
    if (isMax) {
      return !!getCurrentChatId();
    }
    if (isVK) {
      return isVkChatOpen();
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Кнопка-лаунчер (как в VK-версии, стиль MAX)
  // ------------------------------------------------------------------
  function createLauncher() {
    removeElement('maxair-launcher');

    var launcher = document.createElement('button');

    launcher.id = 'maxair-launcher';
    launcher.type = 'button';
    launcher.textContent = '✨ Резюме чата';

    var bgColor = isMax ? '#0aa8f0' : '#4a76a8';
    var hoverColor = isMax ? '#0890c9' : '#3f6692';

    launcher.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:80px;' +
      'z-index:999998;' +
      'padding:10px 16px;' +
      'background:' + bgColor + ';' +
      'color:#fff;' +
      'border:0;' +
      'border-radius:6px;' +
      'cursor:pointer;' +
      'text-align:center;' +
      'font:14px Arial,sans-serif;' +
      'box-shadow:none;' +
      'transition:background-color 0.2s ease,box-shadow 0.2s ease;';

    document.body.appendChild(launcher);
    launcher.addEventListener('click', startExporter);
    launcher.addEventListener('mouseover', function() {
      launcher.style.background = hoverColor;
      launcher.style.boxShadow = '0 5px 14px rgba(0,0,0,.35);';
    });
    launcher.addEventListener('mouseout', function() {
      launcher.style.background = bgColor;
      launcher.style.boxShadow = 'none';
    });
    updateLauncherVisibility();
  }

  function updateLauncherVisibility() {
    var launcher = document.getElementById('maxair-launcher');

    if (launcher) {
      launcher.style.display = isChatOpen()
        ? 'block'
        : 'none';
    }
  }

  // ------------------------------------------------------------------
  // Набор пользователем способа загрузки сообщений
  // ------------------------------------------------------------------
  function startExporter() {
    var modeMenu = document.getElementById('maxair-mode-menu');

    if (modeMenu) {
      modeMenu.remove();
      return;
    }

    removeElement('maxair-menu');
    removeElement('maxair-status');
    removeElement('maxair-result');

    if (isMax) {
      var chatId = getCurrentChatId();

      if (!chatId) {
        alert(
          'Не удалось определить беседу.\n\n' +
          'Откройте чат на web.max.ru и повторите.'
        );
        return;
      }

      var scroller = findScrollContainer();

      if (!scroller) {
        alert(
          'Не удалось найти список сообщений.\n\n' +
          'Откройте чат, затем запустите в консоли:\n' +
          'window.__maxAirInspect()\n' +
          'и пришлите результат для настройки селекторов DOM.'
        );
        return;
      }

      showModeMenu(chatId, scroller);
    } else if (isVK) {
      var match = pageWindow.location.href.match(
        /\/convo\/(\d+)/
      );

      var urlId = match
        ? parseInt(match[1], 10)
        : null;

      if (!urlId) {
        alert(
          'Не удалось определить ID беседы.\n\n' +
          'Откройте чат с адресом вида /im/convo/123.'
        );
        return;
      }

      var peerId = urlId >= 2000000000
        ? urlId
        : 2000000000 + urlId;

      showVkModeMenu(peerId);
    }
  }

  function showModeMenu(chatId, scroller) {
    removeElement('maxair-mode-menu');

    var menu = document.createElement('div');

    menu.id = 'maxair-mode-menu';
    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:136px;' +
      'z-index:999999;' +
      'width:310px;' +
      'padding:16px;' +
      'background:#2b2b31;' +
      'color:#eee;' +
      'border:1px solid #444;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var countLabel = document.createElement('label');
    countLabel.textContent = 'Последние сообщения:';
    countLabel.style.cssText =
      'display:block;margin-top:0;font-weight:bold;';

    var countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '500';
    countInput.value = '80';
    countInput.style.cssText =
      'display:block;width:100%;box-sizing:border-box;' +
      'margin-top:6px;padding:9px;border:1px solid #ccd3da;' +
      'border-radius:5px;font-size:14px;';

    var countButton = createModeButton(
      'Загрузить последние сообщения',
      '#0aa8f0',
      '📋'
    );

    var daysLabel = document.createElement('label');
    daysLabel.textContent = 'Сообщения за период, дней:';
    daysLabel.style.cssText =
      'display:block;margin-top:14px;font-weight:bold;';

    var daysInput = document.createElement('input');
    daysInput.type = 'number';
    daysInput.min = '1';
    daysInput.value = '1';
    daysInput.style.cssText =
      'display:block;width:100%;box-sizing:border-box;' +
      'margin-top:6px;padding:9px;border:1px solid #ccd3da;' +
      'border-radius:5px;font-size:14px;';

    var daysButton = createModeButton(
      'Загрузить сообщения за период',
      '#2d8a57',
      '📅'
    );

    menu.appendChild(countLabel);
    menu.appendChild(countInput);
    menu.appendChild(countButton);
    menu.appendChild(daysLabel);
    menu.appendChild(daysInput);
    menu.appendChild(daysButton);
    document.body.appendChild(menu);

    countButton.addEventListener('click', function() {
      var count = Math.min(
        Math.max(parseInt(countInput.value, 10) || 80, 1),
        500
      );

      menu.remove();
      loadMessagesFromDom(scroller, count, null);
    });

    daysButton.addEventListener('click', function() {
      var days = Math.max(
        parseInt(daysInput.value, 10) || 2,
        1
      );

      var targetDate = Math.floor(Date.now() / 1000) -
        days * 24 * 60 * 60;

      menu.remove();
      loadMessagesFromDom(scroller, null, targetDate);
    });
  }

  function createModeButton(text, color, icon) {
    var button = makeButton(text, color, icon);

    button.style.marginTop = '8px';

    return button;
  }

  function showVkModeMenu(peerId) {
    removeElement('maxair-mode-menu');

    var menu = document.createElement('div');

    menu.id = 'maxair-mode-menu';
    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:136px;' +
      'z-index:999999;' +
      'width:310px;' +
      'padding:16px;' +
      'background:#2b2b31;' +
      'color:#eee;' +
      'border:1px solid #444;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var countLabel = document.createElement('label');
    countLabel.textContent = 'Последние сообщения:';
    countLabel.style.cssText =
      'display:block;margin-top:0;font-weight:bold;';

    var countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '200';
    countInput.value = '80';
    countInput.style.cssText =
      'display:block;width:100%;box-sizing:border-box;' +
      'margin-top:6px;padding:9px;border:1px solid #ccd3da;' +
      'border-radius:5px;font-size:14px;';

    var countButton = createModeButton(
      'Загрузить последние сообщения',
      '#4a76a8',
      '📋'
    );

    var daysLabel = document.createElement('label');
    daysLabel.textContent = 'Сообщения за период, дней:';
    daysLabel.style.cssText =
      'display:block;margin-top:14px;font-weight:bold;';

    var daysInput = document.createElement('input');
    daysInput.type = 'number';
    daysInput.min = '1';
    daysInput.value = '1';
    daysInput.style.cssText =
      'display:block;width:100%;box-sizing:border-box;' +
      'margin-top:6px;padding:9px;border:1px solid #ccd3da;' +
      'border-radius:5px;font-size:14px;';

    var daysButton = createModeButton(
      'Загрузить сообщения за период',
      '#2d8a57',
      '📅'
    );

    menu.appendChild(countLabel);
    menu.appendChild(countInput);
    menu.appendChild(countButton);
    menu.appendChild(daysLabel);
    menu.appendChild(daysInput);
    menu.appendChild(daysButton);
    document.body.appendChild(menu);

    countButton.addEventListener('click', function() {
      var count = Math.min(
        Math.max(parseInt(countInput.value, 10) || 80, 1),
        200
      );

      menu.remove();
      loadMessagesFromVkApi(peerId, count, null);
    });

    daysButton.addEventListener('click', function() {
      var days = Math.max(
        parseInt(daysInput.value, 10) || 2,
        1
      );

      var targetDate = Math.floor(Date.now() / 1000) -
        days * 24 * 60 * 60;

      menu.remove();
      loadMessagesFromVkApi(peerId, null, targetDate);
    });
  }

  // ------------------------------------------------------------------
  // Поиск контейнера прокрутки сообщений
  // ------------------------------------------------------------------
  // Является ли элемент прокручиваемым контейнером со списком сообщений
  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }

    var cs = getComputedStyle(el);
    var ov = cs.overflowY;

    if (ov !== 'auto' && ov !== 'scroll') {
      return false;
    }

    return el.scrollHeight > el.clientHeight + 20;
  }

  // Содержит ли элемент (в текущих DOM) строки сообщений
  function hasMessages(el) {
    return !!el.querySelector('[data-author-color]');
  }

  // Возвращает ближайшего предка с искомым классом (аналог closest)
  function closestByClass(el, cls) {
    var n = el;

    while (n && n !== document.body) {
      if (String(n.className).indexOf(cls) !== -1) {
        return n;
      }
      n = n.parentElement;
    }

    return null;
  }

  // Находит контейнер прокрутки списка сообщений.
  // Список сообщений в MAX - это элемент с классом .scrollListScrollable,
  // который находится внутри области .openedChat открытой беседы.
  // В области .openedChat сообщения живут отдельно от поля ввода, а в 1-на-1
  // беседах у сообщений нет блока автора [data-author-color], поэтому поиск
  // идёт по классу и близости к открытой беседе (а не по атрибуту автора).
  function findScrollContainer() {
    var composer = document.querySelector(DOM_CONF.composerSelector);
    var chatRoot = composer ? closestByClass(composer, 'openedChat') : null;

    var candidates = [];

    // Кандидаты из настроенного селектора (может совпадать с несколькими
    // элементами, например sidebar и список сообщений текущей беседы).
    if (DOM_CONF.scrollContainerSelector) {
      candidates = Array.prototype.slice.call(
        document.querySelectorAll(DOM_CONF.scrollContainerSelector)
      );
    }

    // Дополняем общим списком прокручиваемых элементов
    Array.prototype.slice.call(
      document.querySelectorAll('.scrollListScrollable')
    ).forEach(function(el) {
      if (candidates.indexOf(el) === -1) {
        candidates.push(el);
      }
    });

    if (candidates.length) {
      var scored = candidates.map(function(sl) {
        var score = 0;

        // Главный приоритет: контейнер внутри открытой беседы (.openedChat)
        if (chatRoot && chatRoot.contains(sl)) {
          score += 100;
        }

        // Сообщения почти всегда содержат больше контента
        if (hasMessages(sl)) {
          score += 30;
        }

        return { el: sl, score: score };
      });

      scored.sort(function(a, b) {
        return b.score - a.score;
      });

      if (scored[0] && scored[0].score > 0) {
        return scored[0].el;
      }

      // Если ни один не оказался явно в беседе - берём системный fallback
      var fallback = document.querySelector(
        DOM_CONF.scrollContainerSelector ||
        '.scrollListScrollable'
      );
      if (fallback) {
        return fallback;
      }
    }

    // Запасной вариант: любой прокручиваемый элемент со строками сообщений
    var all = document.querySelectorAll('*');

    for (var k = 0; k < all.length; k++) {
      if (isScrollable(all[k]) && hasMessages(all[k])) {
        return all[k];
      }
    }

    return null;
  }

  // ------------------------------------------------------------------
  // Загрузка сообщений из DOM (скрейпинг)
  // ------------------------------------------------------------------
  // ВАЖНО про web.max.ru: список сообщений ВИРТУАЛИЗИРОВАННЫЙ - в DOM
  // одновременно присутствует лишь окно (у нас ~25 .item), а более старые
  // подгружаются только когда верхний sentinel попадает в зону видимости.
  // Направление скролла (0 = свежие или 0 = старые) зависит от способа
  // привязки списка, поэтому ниже направление АВТОКАЛИБРУЕТСЯ по data-index
  // (самые свежие имеют наибольший индекс), а дальше идём к старым
  // шагами по видимой высоте, давая MAX время на подгрузку.
  function loadMessagesFromDom(scroller, limit, targetDate) {
    var messages = [];
    var seen = {};
    var finished = false;
    var noNewRounds = 0;
    var noScrollRounds = 0;
    var edgeHoldRounds = 0;
    var dateState = { date: null, lastAuthor: '' };
    var maxPatience = 30;
    var totalRounds = 0;
    var maxRounds = 1500;
    // Направление движения к более старым сообщениям в scrollTop:
    // +1 = старые при УВЕЛИЧЕНИИ scrollTop (--bottom, 0 = свежие),
    // -1 = старые при УМЕНЬШЕНИИ scrollTop (обычный список). Калибруется в startFromNewest.
    var olderDir = 1;
    var calibrated = false;
    var lastScrollHeight = 0;
    // Рабочее направление подтяжки истории: сначала = калиброванное olderDir,
    // но если по факту getMessages/scrollHeight не растут - переворачиваем
    // (dirFlips ограничивает число смен направления).
    var scrollDir = 1;
    var dirFlips = 0;
    var maxDirFlips = 4;
    // Порог неактивности (раундов), после которого пробуем сменить направление
    // или завершиться.
    var pullQuietRounds = 0;
    // Жёсткий таймаут всего сбора (мс), чтобы цикл никогда не висел вечно.
    var cycleT0 = Date.now();
    var maxCycleMs = 240000;
    // Кол-во подряд идущих раундов, когда строки есть, но НИ ОДНА не
    // распозналась парсером → селекторы не подходят для этого чата.
    var unparsedRounds = 0;

    showStatus('Загрузка сообщений...');

    // Контейнер переспрашиваем на каждом шаге: в SPA-приложении DOM беседы
    // пересобирается при переключении чатов, и переданный элемент может
    // оказаться отсоединённым.
    var current = scroller || findScrollContainer();

    startFromNewest();

    function acquireContainer() {
      if (current && !document.documentElement.contains(current)) {
        current = findScrollContainer();
      }

      if (!current) {
        current = findScrollContainer();
      }

      return current;
    }

    function maxVisibleIndex() {
      var rows = getMessageRows(current);
      var max = -1;

      for (var i = 0; i < rows.length; i++) {
        var idx = parseInt(
          rows[i].getAttribute && rows[i].getAttribute('data-index'),
          10
        );

        if (!isNaN(idx) && idx > max) {
          max = idx;
        }
      }

      return max;
    }

    function startFromNewest() {
      if (!acquireContainer()) {
        console.warn('[MAXAir] контейнер прокрутки не найден');
        finish();
        return;
      }

      // Калибровка направления: самые свежие сообщения имеют наибольший
      // data-index. Смотрим, где их больше - при scrollTop=0 или при максимуме.
      if (!calibrated) {
        calibrated = true;

        current.scrollTop = 0;
        var idxZero = maxVisibleIndex();

        current.scrollTop = current.scrollHeight;
        var idxMax = maxVisibleIndex();

        // Свежие там, где index больше
        if (idxZero >= idxMax) {
          olderDir = 1; // 0 = свежие, вверх = старые (--bottom)
        } else {
          olderDir = -1; // низ = свежие, вверх = старые (обычный)
        }

        console.warn('[MAXAir] калибровка направления: свежие при scrollTop=0 -> ' +
          (idxZero >= idxMax) + ', olderDir=' + olderDir,
          { idxZero: idxZero, idxMax: idxMax });
      }

      scrollDir = olderDir;

      // Стартуем с самых свежих
      if (olderDir === 1) {
        current.scrollTop = 0;
      } else {
        current.scrollTop = current.scrollHeight;
      }

      collectPage();
    }

    function collectPage() {
      try {
        if (finished) {
          return;
        }

      acquireContainer();

      if (!current) {
        console.warn('[MAXAir] контейнер прокрутки не найден');
        finish();
        return;
      }

      totalRounds++;

      // Диагностика каждой итерации: контейнер, позиция и сколько раз MAX
      // ответил getMessages (через WS-хук). Помогает увидеть, реально ли
      // крутится список и подгружается ли история.
      console.warn(
        '[MAXAir][D] r' + totalRounds +
        ' st=' + current.scrollTop + '/' + current.scrollHeight +
        ' ch=' + current.clientHeight +
        ' rows=' + getMessageRows(current).length +
        ' msgs=' + messages.length +
        ' olderDir=' + olderDir +
        ' cls=' + String(current.className || current.tagName).slice(0, 40)
      );

      var before = messages.length;
      var firstIdx = null;
      var lastIdx = null;
      var parsedCount = 0;
      var newCount = 0;
      var rows = getMessageRows(current);
      var rowCount = rows.length;

      for (var i = 0; i < rows.length; i++) {
        var pIdx = parseInt(
          rows[i].getAttribute && rows[i].getAttribute('data-index'),
          10
        );

        if (i === 0 && !isNaN(pIdx)) {
          firstIdx = pIdx;
        }

        if (i === rows.length - 1 && !isNaN(pIdx)) {
          lastIdx = pIdx;
        }

        var entry = parseMessageRow(rows[i], dateState);

        if (!entry) {
          continue;
        }

        parsedCount++;

        var key = entry.date + '|' + entry.author + '|' + entry.text;

        if (seen[key]) {
          continue;
        }

        seen[key] = true;
        newCount++;

        messages.push({
          date: entry.date,
          author: entry.author,
          text: entry.text,
          replyText: entry.replyText,
          replyAuthor: entry.replyAuthor
        });
      }

      // Диагностика: если DOM полон .item, но ничего не распознаётся как новое,
      // видно - либо парсер не находит текст (parsedCount << rowCount),
      // либо сообщения дублируются (newCount === 0 при parsedCount > 0).
      console.warn(
        '[MAXAir][D] r' + totalRounds +
        ' rows=' + rowCount +
        ' parsed=' + parsedCount +
        ' new=' + newCount +
        ' total=' + messages.length +
        ' idx=' + firstIdx + '..' + lastIdx +
        ' scroll=' + current.scrollTop + '/' + current.scrollHeight
      );

      // Предохранитель: есть строки, но ни одна не распознана - селекторы
      // не подходят для этого чата. Завершаемся и подсказываем __maxAirInspect.
      if (rowCount > 0 && parsedCount === 0) {
        unparsedRounds++;
        if (unparsedRounds >= 6) {
          console.warn(
            '[MAXAir] строки есть, но парсер ничего не распознаёт ' +
            '(rows=' + rowCount + ', собрано там ' + messages.length +
            ') - проверьте селекторы DOM'
          );
          finish();
          return;
        }
      } else {
        unparsedRounds = 0;
      }

      messages.sort(function(a, b) {
        return a.date - b.date;
      });

      showStatus('Загружено сообщений: ' + messages.length);

      // Режим "за последние N дней": прошли вниз границу периода - хватит
      if (targetDate && messages.length && messages[0].date < targetDate) {
        finish();
        return;
      }

      // Режим "последние N сообщений": набрали нужный объём
      if (!targetDate && messages.length >= limit) {
        finish();
        return;
      }

      var noNew = messages.length <= before;

      if (rowCount === 0) {
        // Список ещё рендерится - ждём, не двигаясь (чтобы не потерять позицию)
        if (noNewRounds >= maxPatience) {
          finish();
          return;
        }

        noNewRounds++;
        setTimeout(collectPage, 300);
        return;
      }

      if (noNew) {
        noNewRounds++;
      } else {
        noNewRounds = 0;
      }

      // Тянем историю через ПРЯМУЮ установку scrollTop (проверено тестом
      // прямым назначением): каждая установка scrollTop заставляет MAX слать
      // getMessages и догружать старые сообщения -> растёт scrollHeight и в
      // DOM появляются новые .item. Синтетические wheel-события НЕ работают.
      //
      // Стратегия: не полагаемся на калибровку направления. Каждый раунд
      // делаем серию рывков scrollTop к "старому" краю в текущем scrollDir.
      // Наблюдаем, растёт ли scrollHeight и отвечает ли MAX getMessages.
      // Если несколько раундов подряд тихо - переворачиваем направление
      // (максимум maxDirFlips раз), затем завершаемся.

      // Сначала доезжаем к старому краю в выбранном направлении
      pullToEdge(scrollDir);

      // Затем серия рывков за край, каждый - новая установка scrollTop
      PULL_OLDER(current, scrollDir);

      // Ждём, пока MAX обработает (асинхронно шлёт getMessages и рендерит)
      setTimeout(proceedAfterPull, 200);

      function proceedAfterPull() {
        if (finished) {
          return;
        }

        // Если контейнер пропал (SPA-переход) - переспросим
        if (!current || !document.documentElement.contains(current)) {
          acquireContainer();
        }

        // Главный индикатор прогресса - РЕАЛЬНО появившиеся новые сообщения
        // (newCount считается в начале этого раунда). НЕ полагаемся на
        // scrollHeight: из-за виртуализации он может колебаться и вечно
        // сбрасывать счётчики, из-за чего цикл зависал на "Загрузка...".
        if (newCount > 0) {
          noNewRounds = 0;
          edgeHoldRounds = 0;
          pullQuietRounds = 0;
        } else {
          noNewRounds++;
          edgeHoldRounds++;
        }

        // Жёсткий таймаут по времени - предохранитель от зависания
        if (Date.now() - cycleT0 >= maxCycleMs) {
          console.warn(
            '[MAXAir] остановка по таймауту (собрано ' +
            messages.length + ')'
          );
          finish();
          return;
        }

        // Не было новых сообщений достаточно долго - дошли до конца
        if (noNewRounds >= 25) {
          console.warn(
            '[MAXAir] завершено: нет новых сообщений (собрано ' +
            messages.length + ')'
          );
          finish();
          return;
        }

        // Направление не даёт загрузку: тихо долго, но ещё есть запас флипов
        if (edgeHoldRounds >= 12 && dirFlips < maxDirFlips) {
          dirFlips++;
          scrollDir = -scrollDir;
          noNewRounds = 0;
          edgeHoldRounds = 0;
          pullQuietRounds = 0;
          console.warn(
            '[MAXAir] смена направления на ' + scrollDir +
            ' (собрано ' + messages.length + ', f=' + dirFlips + ')'
          );
          if (scrollDir === 1) {
            current.scrollTop = 0;
          } else {
            current.scrollTop = current.scrollHeight;
          }
          setTimeout(collectPage, 300);
          return;
        }

        setTimeout(collectPage, 300);
      }

      // Предохранитель от бесконечного цикла (проверяем и до таймера)
      if (totalRounds >= maxRounds || Date.now() - cycleT0 >= maxCycleMs) {
        console.warn('[MAXAir] превышен лимит итераций', messages.length);
        finish();
        return;
      }
      } catch (err) {
        // Любая ошибка внутри раунда не должна тихо убивать цикл и оставлять
        // висящую надпись "Загрузка..." - логируем и завершаемся.
        console.error('[MAXAir][ERR] ошибка в цикле сбора:', err);
        finish();
      }
    }

    // Подъезжает к старому краю контейнера в выбранном направлении.
    function pullToEdge(dir) {
      if (!current || !document.documentElement.contains(current)) {
        acquireContainer();
      }
      if (!current) {
        return;
      }
      try {
        current.scrollTop = dir === 1 ? current.scrollHeight : 0;
      } catch (e) {}
    }

    function finish() {
      if (finished) {
        return;
      }

      finished = true;
      removeElement('maxair-status');

      if (!messages.length) {
        console.warn('[MAXAir][FINISH] причин: messages пуст', {
          waitMs: (Date.now() - cycleT0),
          scroller: current,
          rows: current ? getMessageRows(current).length : 0
        });
        alert(
          'Не удалось найти сообщения.\n\n' +
          'Запустите в консоли:\n' +
          'window.__maxAirInspect()\n' +
          'и пришлите результат для настройки селекторов DOM.'
        );
        return;
      }

      // messages отсортированы по дате (от старых к новым).
      // Для режима "за последние N дней" оставляем только то, что новее границы.
      var selected = targetDate
        ? messages.filter(function(m) { return m.date >= targetDate; })
        : messages.slice(-limit);

      if (!selected.length) {
        console.warn('[MAXAir][FINISH] selected пуст при msgs=' + messages.length,
          { targetDate: targetDate, limit: limit });
        alert('Сообщения не найдены');
        return;
      }

      // --- Ответы: добавляем "Ответ на сообщение ДАТА ВРЕМЯ от УЧАСТНИК" ---
      // для сообщений, которые цитируют другое. Дату/время цитируемого ищем
      // среди ВСЕХ собранных сообщений по совпадению текста-цитаты. Если не
      // нашли - берём дату/время самого ответа как запасной вариант.
      function normReply(str) {
        return (str || '').replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, ' ')
          .trim().toLowerCase();
      }

      var quoteIndex = {};
      var quoteKeys = [];
      for (var qi = 0; qi < messages.length; qi++) {
        var qmsg = messages[qi];
        if (!qmsg.text) continue;
        var k = normReply(qmsg.text);
        if (k && typeof quoteIndex[k] === 'undefined') {
          quoteIndex[k] = qmsg;
          quoteKeys.push(k);
        }
      }

      function findQuoted(replyText) {
        var rk = normReply(replyText);
        if (!rk) return null;
        if (quoteIndex[rk]) return quoteIndex[rk];
        // MAX может обрезать длинную цитату многоточием - ищем по началу
        for (var i = 0; i < quoteKeys.length; i++) {
          var key = quoteKeys[i];
          if (key.indexOf(rk) === 0 || rk.indexOf(key) === 0) {
            return quoteIndex[key];
          }
        }
        return null;
      }

      function formatReplyDate(ts) {
        var d = new Date(ts * 1000);
        var dd = ('0' + d.getDate()).slice(-2);
        var mm = ('0' + (d.getMonth() + 1)).slice(-2);
        var yyyy = d.getFullYear();
        var hh = ('0' + d.getHours()).slice(-2);
        var mi = ('0' + d.getMinutes()).slice(-2);
        return dd + '.' + mm + '.' + yyyy + ' ' + hh + ':' + mi;
      }

      for (var ri = 0; ri < selected.length; ri++) {
        var m = selected[ri];
        if (!m || !m.replyText) continue;

        var quoted = findQuoted(m.replyText);
        var replyTs = quoted ? quoted.date : m.date;
        var replyAuthor = m.replyAuthor || (quoted ? quoted.author : '');

        m.text = 'Ответ на сообщение ' + formatReplyDate(replyTs) +
          ' от ' + replyAuthor + '\n' + m.text;
      }

      var text = selected.map(function(message) {
        var date = new Date(message.date * 1000);
        var dateText = date.toLocaleDateString('ru-RU');
        var timeText = date.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit'
        });

        return '[' + dateText + ' ' + timeText + '] ' +
          message.author + ':\n' +
          message.text
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();
      }).join('\n\n---\n\n');

      showPromptMenu(text, selected.length, formatSamplingPeriod(selected));
    }
  }

  // Тянет историю к СТАРОМУ краю через прямую установку scrollTop.
  // Доказано тестом: синтетические wheel/scroll-события
  // MAX игнорирует, НО прямая установка container.scrollTop (scrollTop=0,
  // scrollTo(0,0), плавное уменьшение, отрицательное значение) реально
  // заставляет MAX отправлять getMessages и догружать старые сообщения
  // (фрейм getMessages с убывающим курсором from). dir: 1 = старые при
  // большом scrollTop, -1 = старые при малом.
  function PULL_OLDER(container, dir) {
    if (!container) {
      return;
    }

    try {
      var edge = dir === 1 ? container.scrollHeight : 0;
      // overshoot - значение заметно ЗА краем, чтобы каждая установка давала
      // НОВОЕ значение scrollTop и гарантированно триггерила getMessages,
      // даже когда контейнер уже упирается в край.
      var overshoot = dir === 1
        ? container.scrollHeight + (container.clientHeight || 400) * 3
        : -((container.clientHeight || 400) * 3);

      // Сначала сразу на край
      container.scrollTop = edge;

      // Серия рывков: попеременно за край и обратно на край, с паузами,
      // чтобы MAX успевал принять каждую установку отдельно (он асинхронно
      // шлёт getMessages и рендерит подгруженные строки).
      for (var i = 0; i < 6; i++) {
        (function(step) {
          setTimeout(function() {
            if (!container || !document.documentElement.contains(container)) {
              return;
            }
            container.scrollTop = (step % 2 === 0) ? overshoot : edge;
          }, 25 * (i + 1));
        })(i);
      }
    } catch (error) {
      console.warn('[MAXAir] pull ошибка:', error.message);
    }
  }

  // Возвращает сгенерированные в DOM строки сообщений (виртуальные элементы
  // .item[data-index] внутри контейнера прокрутки).
  function getMessageRows(scroller) {
    if (DOM_CONF.messageRowSelector) {
      return Array.prototype.slice.call(
        scroller.querySelectorAll(DOM_CONF.messageRowSelector)
      );
    }

    return Array.prototype.slice.call(
      scroller.querySelectorAll('.item')
    );
  }

  var RUS_MONTHS = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
    'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
    'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };

  // Разбирает дату-разделитель в объект Date:
  //   "Сегодня" -> сейчас (00:00)
  //   "Вчера"   -> вчера (00:00)
  //   "6 июня 2026" -> конкретная дата
  function parseCapsuleDate(text) {
    if (!text) {
      return null;
    }

    var t = text.trim();

    var now = new Date();

    if (/^сегодня$/i.test(t)) {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    if (/^вчера$/i.test(t)) {
      var y = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      y.setDate(y.getDate() - 1);
      return y;
    }

    var m = t.match(
      /^(\d{1,2})\s+([а-яё]+)\s+(\d{4})$/i
    );

    if (!m) {
      return null;
    }

    var day = parseInt(m[1], 10);
    var month = RUS_MONTHS[m[2].toLowerCase()];
    var year = parseInt(m[3], 10);

    if (month === undefined) {
      return null;
    }

    return new Date(year, month, day);
  }

  // Разбирает строку времени "14:40" и объединяет с датой дня
  function applyTimeToDate(dayDate, timeStr) {
    if (dayDate === null) {
      dayDate = new Date();
    }

    var d = new Date(dayDate.getTime());
    var m = (timeStr || '').trim().match(/^(\d{1,2}):(\d{2})/);

    if (m) {
      d.setHours(
        Math.min(parseInt(m[1], 10), 23),
        Math.min(parseInt(m[2], 10), 59),
        0, 0
      );
    }

    return Math.floor(d.getTime() / 1000);
  }

  // Разбирает один элемент .item в { author, text, date }.
  // state.date хранит текущий "день" из разделителей-капсул, т.к. у
  // самих сообщений в MAX показывается только время.
  function parseMessageRow(row, state) {
    // Дата-разделитель (капсула) внутри элемента
    var dateNode = DOM_CONF.dateSelector
      ? row.querySelector(DOM_CONF.dateSelector)
      : row.querySelector('.capsuleSeparator .capsule');

    if (dateNode) {
      var parsedDate = parseCapsuleDate(dateNode.textContent);
      if (parsedDate) {
        state.date = parsedDate;
      }
    }

    var block = row.querySelector('.block');
    if (!block) {
      return null;
    }

    var bubble = block.querySelector('.bubbleContent');
    if (!bubble) {
      return null;
    }

    var variantNode = bubble.querySelector('[data-bubbles-variant]');
    var incoming = variantNode &&
      variantNode.getAttribute('data-bubbles-variant') === 'incoming';

    var author = '';
    var authorNode = block.querySelector(
      DOM_CONF.messageAuthorSelector ||
      '.bubbleContent .header .name .text'
    );

    if (authorNode && authorNode.textContent.trim()) {
      author = authorNode.textContent.trim();
      // Запоминаем автора, чтобы наследовать его следующим сообщениям той же
      // серии (MAX показывает имя только у первого сообщения группы).
      state.lastAuthor = author;
    } else {
      // У этой строки нет подписи автора (продолжение серии). Наследуем автора
      // ПРЕДЫДУЩЕГО сообщения. Если предыдущего автора нет - для своих
      // (исходящих) ставим "Я".
      author = state.lastAuthor || (!incoming ? 'Я' : '');
    }

    var textNode = block.querySelector(
      DOM_CONF.messageTextSelector ||
      '.bubbleContent > .text'
    );
    var text = textNode ? textNode.textContent.trim() : '';

    var timeNode = block.querySelector(
      DOM_CONF.messageTimeSelector ||
      '.bubbleContent .meta .text'
    );
    var timeStr = timeNode ? timeNode.textContent.trim() : '';

    text = (text || '').replace(/[\u200B\u200C\u200D\uFEFF]/g, '').trim();

    if (!text) {
      return null;
    }

    var date = applyTimeToDate(state.date, timeStr);

    // Ответ на другое сообщение: внутри пузыря есть блок-кнопка с автором
    // цитируемого и текстом-цитатой. Запоминаем цитату и автора, чтобы позже
    // (в finish) найти само цитируемое сообщение и подставить его дату/время.
    var replyBlock = DOM_CONF.replyBlockSelector
      ? block.querySelector(DOM_CONF.replyBlockSelector)
      : block.querySelector('.link button.mark');

    var replyText = '';
    var replyAuthor = '';

    if (replyBlock) {
      // Цитата - это ПРЯМОЙ span.text внутри кнопки (не вложенный в author).
      // querySelector не принимает селектор '> .text' (это вызывало DOMException
      // и убивало цикл), поэтому перебираем прямых потомков вручную.
      var kids = replyBlock.children;
      for (var ki = 0; ki < kids.length; ki++) {
        var kid = kids[ki];
        if ((kid.classList && kid.classList.contains('text')) ||
            (kid.className && /(^|\s)text(\s|$)/.test(kid.className))) {
          replyText = kid.textContent.trim()
            .replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, ' ');
          break;
        }
      }

      var replyAuthorNode = DOM_CONF.replyAuthorSelector
        ? replyBlock.querySelector(DOM_CONF.replyAuthorSelector)
        : replyBlock.querySelector('.author .name .text');
      if (replyAuthorNode) {
        replyAuthor = replyAuthorNode.textContent.trim();
      }
    }

    return {
      author: author || 'ID-' + Math.round(Math.random() * 1e6),
      text: text,
      date: date,
      replyText: replyText,
      replyAuthor: replyAuthor
    };
  }

  function formatSamplingPeriod(messages) {
    var firstDate = messages[0].date;
    var lastDate = messages[messages.length - 1].date;
    var totalHours = Math.max(
      Math.ceil((lastDate - firstDate) / 3600),
      1
    );

    if (totalHours > 24) {
      var days = Math.floor(totalHours / 24);
      var hours = totalHours % 24;

      return hours
        ? days + ' дн. ' + hours + ' ч.'
        : days + ' дн.';
    }

    return totalHours + ' ч.';
  }

  // ------------------------------------------------------------------
  // Меню выбора провайдера и типа резюме (как в VK-версии)
  // ------------------------------------------------------------------
  function showPromptMenu(messagesText, count, periodText) {
    removeElement('maxair-prompt-menu');

    var menu = document.createElement('div');

    menu.id = 'maxair-prompt-menu';
    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:72px;' +
      'z-index:999999;' +
      'width:max-content;' +
      'min-width:min(280px,calc(100vw - 40px));' +
      'max-width:calc(100vw - 40px);' +
      'padding:16px;' +
      'background:#2b2b31;' +
      'color:#eee;' +
      'border:1px solid #444;' +
      'border-radius:8px;' +
      'box-shadow:0 12px 24px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = 'Настройки резюме';
    title.style.cssText =
      'margin-bottom:12px;' +
      'font-weight:bold;';

    var providerLabel = document.createElement('label');
    providerLabel.textContent = 'Провайдер AI:';
    providerLabel.style.cssText =
      'display:block;margin-top:0;font-weight:bold;';

    var providerSelect = document.createElement('select');
    providerSelect.style.cssText =
      'display:block;width:100%;box-sizing:border-box;' +
      'margin-top:6px;padding:9px;border:1px solid #ccd3da;' +
      'border-radius:5px;font-size:14px;';

    var providerKeys = Object.keys(PROVIDERS);
    var savedProvider = getSavedProvider();
    for (var i = 0; i < providerKeys.length; i++) {
      var key = providerKeys[i];
      var option = document.createElement('option');
      option.value = key;
      option.textContent = PROVIDERS[key].name;
      providerSelect.appendChild(option);
    }
    providerSelect.value = savedProvider;

    providerSelect.addEventListener('change', function() {
      saveProvider(providerSelect.value);
    });

    var allEventsButton = createModeButton(
      'Все события',
      '#0aa8f0',
      '💯'
    );

    var importantButton = createModeButton(
      'Только важные',
      '#2d8a57',
      '⭐'
    );

    var copyMessagesButton = makeButton(
      'Копировать сообщения (' + count + ')',
      '#e67e22',
      '📋'
    );

    var savedPrompt = getSavedCustomPrompt();
    var customPromptButton = makeButton(
      savedPrompt ? 'Свой промт ✓' : 'Свой промт',
      '#9b59b6',
      '💬',
      true
    );
    customPromptButton.style.flex = '1';

    var customPromptSettingsBtn = makeButton('', '#666', '⚙️', true);
    customPromptSettingsBtn.style.width = '32px';
    customPromptSettingsBtn.style.minWidth = '32px';
    customPromptSettingsBtn.style.flex = '0 0 32px';
    customPromptSettingsBtn.style.padding = '10px 6px';
    customPromptSettingsBtn.style.fontSize = '12px';

    var customPromptRow = document.createElement('div');
    customPromptRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center;';
    customPromptRow.appendChild(customPromptButton);
    customPromptRow.appendChild(customPromptSettingsBtn);

    var closeButton = makeButton('Закрыть', '#777', '×');

    menu.appendChild(title);
    menu.appendChild(providerLabel);
    menu.appendChild(providerSelect);
    menu.appendChild(allEventsButton);
    menu.appendChild(importantButton);
    menu.appendChild(customPromptRow);
    menu.appendChild(copyMessagesButton);
    menu.appendChild(closeButton);
    document.body.appendChild(menu);

    copyMessagesButton.addEventListener('click', function() {
      copyText(messagesText)
        .then(function() {
          setButtonText(copyMessagesButton, 'Сообщения скопированы');
        })
        .catch(function(error) {
          alert(
            'Ошибка копирования:\n\n' +
            error.message
          );
        });
    });

    allEventsButton.addEventListener('click', function() {
      var provider = providerSelect.value;
      menu.remove();
      autoSummarize(
        messagesText,
        count,
        PROMPT_TEMPLATES.allEvents,
        periodText,
        provider
      );
    });

    importantButton.addEventListener('click', function() {
      var provider = providerSelect.value;
      menu.remove();
      autoSummarize(
        messagesText,
        count,
        PROMPT_TEMPLATES.importantOnly,
        periodText,
        provider
      );
    });

    closeButton.addEventListener('click', function() {
      menu.remove();
      showMenu(messagesText, count, periodText);
    });

    customPromptButton.addEventListener('click', function() {
      var custom = getSavedCustomPrompt();
      if (!custom) {
        alert('Промт не указан.\n\nНажмите ⚙️ рядом с кнопкой, чтобы написать свой промт.');
        return;
      }
      var provider = providerSelect.value;
      menu.remove();
      autoSummarize(
        messagesText,
        count,
        custom,
        periodText,
        provider
      );
    });

    customPromptSettingsBtn.addEventListener('click', function() {
      removeElement('maxair-custom-prompt-editor');

      var overlay = document.createElement('div');
      overlay.id = 'maxair-custom-prompt-editor';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;' +
        'z-index:9999999;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.6);';

      var box = document.createElement('div');
      box.style.cssText =
        'background:#2b2b31;color:#eee;border:1px solid #444;' +
        'border-radius:8px;padding:20px;width:min(500px,calc(100vw - 40px));' +
        'max-height:80vh;display:flex;flex-direction:column;' +
        'box-shadow:0 12px 24px rgba(0,0,0,.4);font:14px Arial,sans-serif;';

      var boxTitle = document.createElement('div');
      boxTitle.textContent = 'Настройка промта';
      boxTitle.style.cssText = 'font-weight:bold;margin-bottom:10px;font-size:16px;';

      var hint = document.createElement('div');
      hint.textContent =
        'Напишите промт для ИИ. Используйте {{TEXT}} как плейсхолдер для сообщений. Если не укажете — сообщения будут добавлены автоматически.';
      hint.style.cssText = 'color:#aaa;font-size:12px;margin-bottom:8px;';

      var textarea = document.createElement('textarea');
      textarea.value = getSavedCustomPrompt();
      textarea.placeholder = 'Пример:\nСоставь краткое резюме переписки.\n\n{{TEXT}}';
      textarea.style.cssText =
        'width:100%;box-sizing:border-box;min-height:200px;' +
        'padding:10px;border:1px solid #555;border-radius:5px;' +
        'background:#1e1e22;color:#eee;font:13px monospace;' +
        'resize:vertical;';

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

      var saveBtn = makeButton('Сохранить', '#2d8a57', '✓');
      var clearBtn = makeButton('Очистить', '#e74c3c', '🗑');
      var cancelBtn = makeButton('Отмена', '#777', '×');

      actions.appendChild(saveBtn);
      actions.appendChild(clearBtn);
      actions.appendChild(cancelBtn);

      box.appendChild(boxTitle);
      box.appendChild(hint);
      box.appendChild(textarea);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      textarea.focus();

      saveBtn.addEventListener('click', function() {
        var val = textarea.value.trim();
        if (val && val.indexOf('{{TEXT}}') === -1) {
          val = val + '\n\n{{TEXT}}';
        }
        saveCustomPrompt(val);
        setButtonText(customPromptButton, val ? 'Свой промт ✓' : 'Свой промт');
        overlay.remove();
      });

      clearBtn.addEventListener('click', function() {
        saveCustomPrompt('');
        setButtonText(customPromptButton, 'Свой промт');
        overlay.remove();
      });

      cancelBtn.addEventListener('click', function() {
        overlay.remove();
      });

      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) {
          overlay.remove();
        }
      });
    });
  }

  // ------------------------------------------------------------------
  // AI-логика (без изменений, перенесена с VK-версии)
  // ------------------------------------------------------------------
  function autoSummarize(
    messagesText,
    count,
    promptTemplate,
    periodText,
    provider
  ) {
    var apiKey = getApiKeyCookie(provider);

    if (!apiKey) {
      apiKey = promptForApiKey(provider);

      if (!apiKey) {
        showPromptMenu(messagesText, count, periodText);
        return;
      }
    }

    showStatus('Анализ выполняется...');

    var anonymized = anonymizeMessages(messagesText);

    makeSummaryWithRetry(
      anonymized.text,
      count,
      apiKey.trim(),
      promptTemplate,
      provider
    )
      .then(function(summary) {
        removeElement('maxair-status');
        showResult(
          restoreAuthorNames(summary, anonymized.names),
          messagesText,
          count,
          periodText
        );
      })
      .catch(function(error) {
        removeElement('maxair-status');

        alert(
          'Ошибка анализа:\n\n' +
          error.message
        );

        showPromptMenu(messagesText, count, periodText);
      });
  }

  function anonymizeMessages(messagesText) {
    var names = {};
    var aliases = {};
    var namePattern = /^(?:Ответ на сообщение \[[^\]]+\] |\[[^\]]+\] )([^:\n]+):$/gm;
    var match;
    var number = 1;

    while ((match = namePattern.exec(messagesText)) !== null) {
      var name = match[1].trim();

      if (!names[name]) {
        var alias = 'User' + ('0000' + number).slice(-4);

        names[name] = alias;
        aliases[alias] = name;
        number++;
      }
    }

    var anonymizedText = messagesText;
    var knownNames = Object.keys(names).sort(function(first, second) {
      return second.length - first.length;
    });

    for (var index = 0; index < knownNames.length; index++) {
      var originalName = knownNames[index];
      var escapedName = originalName.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      anonymizedText = anonymizedText.replace(
        new RegExp(escapedName, 'g'),
        names[originalName]
      );
    }

    return {
      text: anonymizedText,
      names: aliases
    };
  }

  function restoreAuthorNames(summary, names) {
    var aliases = Object.keys(names).sort(function(first, second) {
      return second.length - first.length;
    });
    var restored = summary;

    for (var index = 0; index < aliases.length; index++) {
      restored = restored.replace(
        new RegExp(aliases[index], 'g'),
        names[aliases[index]]
      );
    }

    return restored;
  }

  function showMenu(messagesText, count, periodText) {
    removeElement('maxair-menu');

    var menu = document.createElement('div');

    menu.id = 'maxair-menu';

    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:72px;' +
      'z-index:999999;' +
      'width:max-content;' +
      'min-width:min(240px,calc(100vw - 40px));' +
      'max-width:calc(100vw - 40px);' +
      'padding:16px;' +
      'background:#2b2b31;' +
      'color:#eee;' +
      'border:1px solid #444;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = 'Сообщений: ' + count;
    title.style.fontWeight = 'bold';
    menu.appendChild(title);

    var copyButton = makeButton(
      'Копировать сообщения',
      '#0aa8f0',
      '📋'
    );

    var summaryButton = makeButton(
      'Сделать краткое резюме',
      '#2d8a57',
      '✨'
    );

    var closeButton = makeButton('Закрыть', '#777', '×');

    menu.appendChild(copyButton);
    menu.appendChild(summaryButton);
    menu.appendChild(closeButton);
    document.body.appendChild(menu);

    copyButton.addEventListener('click', function() {
      copyText(messagesText)
        .then(function() {
          setButtonText(copyButton, 'Сообщения скопированы');
        })
        .catch(function(error) {
          alert(
            'Ошибка копирования:\n\n' +
            error.message
          );
        });
    });

    summaryButton.addEventListener('click', function() {
      menu.remove();
      showPromptMenu(messagesText, count, periodText);
    });

    closeButton.addEventListener('click', function() {
      menu.remove();
    });
  }

  function makeSummaryWithRetry(
    messagesText,
    count,
    apiKey,
    promptTemplate,
    provider
  ) {
    var MAX_SHORT_RETRIES = 2;

    function attempt(retriesLeft) {
      return makeSummary(
        messagesText,
        count,
        apiKey,
        promptTemplate,
        provider
      )
        .then(function(summary) {
          saveApiKeyCookie(provider, apiKey);

          var lines = summary.split('\n').filter(function(l) {
            return l.trim().length > 0;
          });

          if (lines.length <= 2 && retriesLeft > 0) {
            showStatus('Ответ слишком короткий, повтор...');
            return attempt(retriesLeft - 1);
          }

          return summary;
        })
        .catch(function(error) {
          if (!isAuthError(error) || isQuotaError(error)) {
            throw error;
          }

          removeApiKeyCookie(provider);

          var newApiKey = promptForApiKey(provider);

          if (!newApiKey) {
            throw new Error(
              'Для повторной попытки нужен API-ключ ' + PROVIDERS[provider].name + '.'
            );
          }

          apiKey = newApiKey;

          return makeSummary(
            messagesText,
            count,
            newApiKey,
            promptTemplate,
            provider
          )
            .then(function(summary) {
              saveApiKeyCookie(provider, newApiKey);
              return summary;
            });
        });
    }

    return attempt(MAX_SHORT_RETRIES);
  }

  function promptForApiKey(provider) {
    var providerName = PROVIDERS[provider].name;
    var apiKey = prompt(
      'Введите API-ключ ' + providerName + ':',
      ''
    );

    return apiKey && apiKey.trim()
      ? apiKey.trim()
      : null;
  }

  function getSavedProvider() {
    try {
      return localStorage.getItem(PROVIDER_STORAGE_KEY) || DEFAULT_PROVIDER;
    } catch (e) {
      return DEFAULT_PROVIDER;
    }
  }

  function saveProvider(provider) {
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    } catch (e) {
    }
  }

  function getSavedCustomPrompt() {
    try {
      return localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function saveCustomPrompt(text) {
    try {
      if (text && text.trim()) {
        localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, text.trim());
      } else {
        localStorage.removeItem(CUSTOM_PROMPT_STORAGE_KEY);
      }
    } catch (e) {}
  }

  function getApiKeyCookie(provider) {
    var key = PROVIDERS[provider].cookieKey;
    var prefix = key + '=';
    var cookies = document.cookie.split(';');

    for (var index = 0; index < cookies.length; index++) {
      var cookie = cookies[index].trim();

      if (cookie.indexOf(prefix) === 0) {
        try {
          return decodeURIComponent(
            cookie.slice(prefix.length)
          );
        } catch (error) {
          return null;
        }
      }
    }

    return null;
  }

  function saveApiKeyCookie(provider, apiKey) {
    var key = PROVIDERS[provider].cookieKey;
    document.cookie = key + '=' +
      encodeURIComponent(apiKey) +
      '; max-age=31536000; path=/; SameSite=Lax';
  }

  function removeApiKeyCookie(provider) {
    var key = PROVIDERS[provider].cookieKey;
    document.cookie = key +
      '=; max-age=0; path=/; SameSite=Lax';
  }

  function isAuthError(error) {
    return error && (
      error.status === 401 ||
      error.status === 403
    );
  }

  function isQuotaError(error) {
    return error && error.code === 'QUOTA_EXHAUSTED';
  }

  function makeSummary(
    messagesText,
    count,
    apiKey,
    promptTemplate,
    provider
  ) {
    var text = messagesText.length > MAX_CHARS
      ? messagesText.slice(-MAX_CHARS)
      : messagesText;

    var prompt = promptTemplate || PROMPT_TEMPLATES.allEvents;
    var providerConfig = PROVIDERS[provider];

    var body = {
      model: providerConfig.model,
      messages: [
        {
          role: 'system',
          content:
            'Анализируй переписку на русском языке. ' +
            'Не выдумывай факты. Отвечай кратко.'
        },
        {
          role: 'user',
          content: prompt.replace('{{TEXT}}', text)
        }
      ],
      temperature: 0.2,
      max_tokens: 2000
    };

    return requestAI(body, apiKey, provider);
  }

  function requestAI(body, apiKey, provider) {
    return new Promise(function(resolve, reject) {
      if (
        typeof GM === 'undefined' ||
        typeof GM.xmlHttpRequest !== 'function'
      ) {
        reject(
          new Error(
            'GM.xmlHttpRequest недоступен. ' +
            'Проверьте строку @grant GM.xmlHttpRequest.'
          )
        );
        return;
      }

      var providerConfig = PROVIDERS[provider];
      var settled = false;

      var timer = setTimeout(function() {
        if (settled) {
          return;
        }

        settled = true;

        reject(
          new Error(
            providerConfig.name + ' не ответил за ' +
            AI_TIMEOUT / 1000 +
            ' секунд.'
          )
        );
      }, AI_TIMEOUT);

      try {
        var headers = {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        };

        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://web.max.ru';
          headers['X-Title'] = 'MAX AI-resumer';
        }

        GM.xmlHttpRequest({
          method: 'POST',
          url: providerConfig.url,
          timeout: AI_TIMEOUT,
          headers: headers,
          data: JSON.stringify(body),
          onload: function(response) {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);

            parseAIResponse(
              response,
              resolve,
              reject,
              provider
            );
          },
          onerror: function() {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);

            reject(
              new Error(
                'Сетевая ошибка при обращении к ' + providerConfig.name + '.'
              )
            );
          },
          ontimeout: function() {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);

            reject(
              new Error(
                providerConfig.name + ' не ответил за ' +
                AI_TIMEOUT / 1000 +
                ' секунд.'
              )
            );
          }
        });
      } catch (error) {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function parseAIResponse(response, resolve, reject, provider) {
    var data;
    var providerName = PROVIDERS[provider].name;

    try {
      data = JSON.parse(response.responseText);
    } catch (error) {
      reject(
        new Error(
          providerName + ' вернул некорректный ответ:\n' +
          response.responseText.substring(0, 500)
        )
      );
      return;
    }

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      var message =
        data.error && data.error.message
          ? data.error.message
          : response.responseText;

      var isQuotaExhausted = /free quota has been exhausted/i.test(
        message
      );

      if (isQuotaExhausted) {
        reject(
          createAIError(
            'Превышен лимит обращений к ' + providerName + '. ',
            response.status,
            'QUOTA_EXHAUSTED'
          )
        );
        return;
      }

      reject(
        createAIError(
          'HTTP ' + response.status + ': ' + message,
          response.status
        )
      );
      return;
    }

    function createAIError(message, status, code) {
      var error = new Error(message);

      error.status = status;
      error.code = code;
      return error;
    }

    var content =
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (typeof content !== 'string') {
      reject(
        new Error(
          providerName + ' не вернул текст резюме.'
        )
      );
      return;
    }

    resolve(content.trim());
  }

  // ------------------------------------------------------------------
  // Окно результата (как в VK-версии)
  // ------------------------------------------------------------------
  function showResult(
    text,
    messagesText,
    count,
    periodText
  ) {
    removeElement('maxair-result');

    var box = document.createElement('div');

    box.id = 'maxair-result';

    box.style.cssText =
      'position:fixed;' +
      'left:50%;' +
      'top:50%;' +
      'transform:translate(-50%,-50%);' +
      'z-index:1000000;' +
      'width:min(700px,90vw);' +
      'padding:16px;' +
      'background:#0aa8f0;' +
      'color:#fff;' +
      'border:1px solid #0890c9;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.35);' +
      'box-sizing:border-box;' +
      'max-height:90vh;' +
      'overflow:hidden;' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = '✨ Резюме чата за последние ' +
      (periodText || '1 ч.');
    title.style.cssText =
      'margin-bottom:10px;' +
      'font-size:16px;' +
      'font-weight:bold;';

    var area = document.createElement('textarea');

    area.value = text;
    area.style.cssText =
      'display:block;' +
      'width:100%;' +
      'height:auto;' +
      'min-height:80px;' +
      'max-height:calc(90vh - 140px);' +
      'box-sizing:border-box;' +
      'padding:10px;' +
      'overflow:auto;' +
      'resize:vertical;' +
      'font:14px Arial,sans-serif;' +
      'background:#f5f5f5;' +
      'color:#333;' +
      'border:1px solid #ddd;' +
      'border-radius:5px;';

    var copyButton = makeButton(
      'Копировать резюме',
      '#2d8a57',
      '📋'
    );

    var copyMessagesButton = messagesText
      ? makeButton(
          'Копировать сообщения (' + count + ')',
          '#66879d',
          '💬'
        )
      : null;

    var closeButton = makeButton('Закрыть', '#777', '×');

    var actions = document.createElement('div');

    actions.style.cssText =
      'display:flex;' +
      'gap:10px;' +
      'margin-top:10px;';

    var buttonWidth = messagesText
      ? (100 / 3) + '%'
      : '50%';

    copyButton.style.width = buttonWidth;
    if (copyMessagesButton) {
      copyMessagesButton.style.width = buttonWidth;
    }
    closeButton.style.width = buttonWidth;
    addButton3dEffect(copyButton);
    if (copyMessagesButton) {
      addButton3dEffect(copyMessagesButton);
    }
    addButton3dEffect(closeButton);
    copyButton.style.marginTop = '0';
    if (copyMessagesButton) {
      copyMessagesButton.style.marginTop = '0';
    }
    closeButton.style.marginTop = '0';

    actions.appendChild(copyButton);
    if (copyMessagesButton) {
      actions.appendChild(copyMessagesButton);
    }
    actions.appendChild(closeButton);

    box.appendChild(title);
    box.appendChild(area);
    box.appendChild(actions);
    document.body.appendChild(box);

    var maxAreaHeight = Math.max(
      window.innerHeight * 0.9 - 175,
      40
    );

    area.style.height = Math.min(
      area.scrollHeight,
      maxAreaHeight
    ) + 'px';

    area.focus();
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;

    copyButton.addEventListener('click', function() {
      var fullText = title.textContent + '\n\n' + area.value;
      copyText(fullText)
        .then(function() {
          setButtonText(copyButton, 'Результат скопирован');
        })
        .catch(function() {
          area.focus();
          area.select();

          alert(
            'Автоматическое копирование не сработало. ' +
            'Текст выделен. Нажмите Ctrl+C.'
          );
        });
    });

    if (copyMessagesButton) {
      copyMessagesButton.addEventListener('click', function() {
        copyText(messagesText)
          .then(function() {
            setButtonText(copyMessagesButton, 'Сообщения скопированы');
          })
          .catch(function() {
            alert(
              'Ошибка копирования:\n\n' +
              'Не удалось скопировать сообщения в буфер обмена.'
            );
          });
      });
    }

    closeButton.addEventListener('click', function() {
      box.remove();
    });
  }

  // ------------------------------------------------------------------
  // Утилиты UI и копирования (как в VK-версии)
  // ------------------------------------------------------------------
  function makeButton(text, color, icon, noMargin) {
    var button = document.createElement('button');
    var label = document.createElement('span');

    button.type = 'button';
    button.textContent = '';
    button.buttonColor = color;

    if (icon) {
      var iconElement = document.createElement('span');

      iconElement.textContent = icon;
      iconElement.setAttribute('aria-hidden', 'true');
      iconElement.style.marginRight = '6px';
      button.appendChild(iconElement);
    }

    label.textContent = text;
    button.appendChild(label);
    button.buttonLabel = label;

    button.style.cssText =
      'display:flex;' +
      'align-items:center;' +
      'justify-content:center;' +
      'width:100%;' +
      (noMargin ? '' : 'margin-top:10px;') +
      'padding:10px;' +
      'background:' + color + ';' +
      'color:#fff;' +
      'border:0;' +
      'border-radius:5px;' +
      'cursor:pointer;' +
      'font-size:14px;' +
      'transition:background-color 0.2s ease;';

    button.addEventListener('mouseover', function() {
      var rgb = hexToRgb(button.buttonColor);
      var darkened = 'rgb(' +
        Math.max(0, rgb.r - 30) + ',' +
        Math.max(0, rgb.g - 30) + ',' +
        Math.max(0, rgb.b - 30) + ')';
      button.style.background = darkened;
    });

    button.addEventListener('mouseout', function() {
      button.style.background = button.buttonColor;
    });

    return button;
  }

  function setButtonText(button, text) {
    button.buttonLabel.textContent = text;
  }

  function addButton3dEffect(button) {
    var baseShadow =
      '0 2px 5px rgba(0,0,0,.25),' +
      '0 1px 3px rgba(0,0,0,.18);';
    var hoverShadow =
      '0 4px 8px rgba(0,0,0,.3),' +
      '0 2px 4px rgba(0,0,0,.2);';

    button.style.boxShadow = baseShadow;
    button.style.borderRadius = '5px';
    button.style.transition =
      'background-color 0.2s ease,transform 0.12s ease,' +
      'box-shadow 0.12s ease;';

    button.addEventListener('mouseover', function() {
      button.style.boxShadow = hoverShadow;
    });

    button.addEventListener('mousedown', function() {
      button.style.transform = 'translateY(2px);';
      button.style.boxShadow = '0 1px 2px rgba(0,0,0,.2);';
    });

    button.addEventListener('mouseup', function() {
      button.style.transform = 'translateY(0);';
      button.style.boxShadow = hoverShadow;
    });

    button.addEventListener('mouseleave', function() {
      button.style.transform = 'translateY(0);';
      button.style.boxShadow = baseShadow;
    });
  }

  function hexToRgb(hex) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  function copyText(text) {
    return new Promise(function(resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText =
        'position:fixed;' +
        'left:-9999px;' +
        'top:0;' +
        'white-space:pre-wrap;';

      document.body.appendChild(area);
      area.focus();
      area.select();

      try {
        var success = document.execCommand('copy');
        document.body.removeChild(area);

        if (success) {
          resolve();
        } else {
          reject(new Error('Не удалось скопировать текст'));
        }
      } catch (error) {
        document.body.removeChild(area);
        reject(error);
      }
    });
  }

  function showStatus(text) {
    var status = document.getElementById('maxair-status');

    if (!status) {
      status = document.createElement('div');
      status.id = 'maxair-status';

      status.style.cssText =
        'position:fixed;' +
        'right:20px;' +
        'bottom:72px;' +
        'z-index:999999;' +
        'padding:10px 14px;' +
      'background:#2b2b31;' +
      'color:#eee;' +
      'border:1px solid #444;' +
        'border-radius:6px;' +
        'font:14px Arial,sans-serif;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.2);';

      document.body.appendChild(status);
    }

    status.textContent = text;
  }

  function removeElement(id) {
    var element = document.getElementById(id);

    if (element) {
      element.remove();
    }
  }

  // ------------------------------------------------------------------
  // Помощник для настройки DOM-селекторов
  // ------------------------------------------------------------------
  // Запустите в консоли браузера на открытой беседе web.max.ru:
  //   window.__maxAirInspect()
  // Он выведет структуру видимого списка сообщений и короткие примеры
  // селекторов, которые нужно вписать в DOM_CONF в начале скрипта.
  // Возвращает строковое описание элемента (тег, id, класс, размеры,
  // значения overflow) для отладки селекторов.
  function describeEl(el, indent) {
    if (!el) {
      return null;
    }

    var cs = getComputedStyle(el);
    var parts = ['<' + el.tagName.toLowerCase() + '>'];

    if (el.id) {
      parts.push('#' + el.id);
    }
    if (el.className && typeof el.className === 'string') {
      parts.push('.' + el.className.split(' ').slice(0, 6).join('.'));
    }
    if (el.getAttribute && el.getAttribute('data-testid')) {
      parts.push('[data-testid="' + el.getAttribute('data-testid') + '"]');
    }
    if (el.getAttribute && el.getAttribute('data-author-color')) {
      parts.push('[author-color=' + el.getAttribute('data-author-color') + ']');
    }
    if (el.getAttribute && el.getAttribute('data-message-id')) {
      parts.push('[msg=' + el.getAttribute('data-message-id') + ']');
    }

    parts.push('client:' + el.clientWidth + 'x' + el.clientHeight);
    parts.push('ov:' + cs.overflowY);

    var text = (el.textContent || '').trim().replace(/\s+/g, ' ');

    return (indent || '') + parts.join(' ') +
      (text ? ' | text="' + text.slice(0, 60) + '"' : '');
  }

  // Строит скелет DOM-дерева (атрибуты + текст) до заданной глубины
  function treeDump(el, depth, maxDepth) {
    var lines = [];

    if (!el || depth > maxDepth) {
      return lines;
    }

    lines.push(describeEl(el, '  '.repeat(depth)));

    Array.prototype.slice.call(el.children).slice(0, 25).forEach(function(child) {
      lines = lines.concat(treeDump(child, depth + 1, maxDepth));
    });

    return lines;
  }

  pageWindow.__maxAirInspect = function() {
    var composer = document.querySelector(DOM_CONF.composerSelector);
    var scroller = findScrollContainer();

    var openedChat = composer
      ? (function() {
          var n = composer.parentElement;
          while (n && n !== document.body) {
            if (String(n.className).indexOf('openedChat') !== -1) {
              return n;
            }
            n = n.parentElement;
          }
          return null;
        })()
      : null;

    var out = {
      chatId: getCurrentChatId(),
      url: pageWindow.location.href,
      composerFound: !!composer,
      scrollContainerFound: !!scroller,
      openedChatFound: !!openedChat
    };

    if (openedChat) {
      out.openedChatTree = treeDump(openedChat, 0, 6);
    }

    // Детали всех прокручиваемых списков (sidebar vs сообщения)
    var scrollLists = Array.prototype.slice.call(
      document.querySelectorAll('.scrollListScrollable')
    );
    out.scrollLists = scrollLists.map(function(sl, idx) {
      var inChat = openedChat ? openedChat.contains(sl) : false;

      return {
        index: idx,
        inOpenedChat: inChat,
        client: sl.clientHeight,
        scroll: sl.scrollHeight,
        children: sl.children.length
      };
    });

    // Структура строк сообщений из найденного контейнера прокрутки
    if (scroller) {
      out.scroller = {
        tag: scroller.tagName.toLowerCase(),
        className: String(scroller.className),
        client: scroller.clientHeight,
        scroll: scroller.scrollHeight,
        directChildren: scroller.children.length
      };

      var firstItem = scroller.querySelector('.item');

      if (firstItem) {
        out.firstItemTree = treeDump(firstItem, 0, 7);
        out.firstItemHtml = firstItem.outerHTML.slice(0, 2500);
      }

      var firstBlock = scroller.querySelector('.block');

      if (firstBlock) {
        out.firstBlockTree = treeDump(firstBlock, 0, 8);
        out.firstBlockHtml = firstBlock.outerHTML.slice(0, 2500);
      }

      // Сводка: имена/времена/тексты в первых элементах
      var timeMarkers = scroller.querySelectorAll('[aria-label="time"], [title]');
      var timeSamples = [];
      Array.prototype.slice.call(timeMarkers).slice(0, 8).forEach(function(t) {
        var inMsg = firstItem && firstItem.contains(t);
        if (inMsg) {
          timeSamples.push(t.tagName + '.' + String(t.className) +
            ' title=' + (t.getAttribute('title') || '') +
            ' text=' + (t.textContent || '').trim().slice(0, 40));
        }
      });
      out.timeSamples = timeSamples;
    }

    console.log('=== MAXAir inspect ===');
    console.log(JSON.stringify(out, null, 2));

    return out;
  };
})();
