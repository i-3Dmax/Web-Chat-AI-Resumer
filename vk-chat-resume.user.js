// ==UserScript==
// @name         VK chat AI-resumer
// @namespace    vk-chat-resume
// @version      2.6.0
// @updateURL    https://raw.githubusercontent.com/i-3Dmax/vk.ru-chat-resume/main/vk-chat-resume.user.js
// @downloadURL  https://raw.githubusercontent.com/i-3Dmax/vk.ru-chat-resume/main/vk-chat-resume.user.js
// @description  Экспорт сообщений VK и резюме через Qwen/DeepSeek
// @match        https://vk.ru/*
// @match        https://vk.com/*
// @grant        unsafeWindow
// @grant        GM.xmlHttpRequest
// @grant        GM.setClipboard
// @grant        GM_registerMenuCommand
// @connect      dashscope-intl.aliyuncs.com
// @connect      dashscope.aliyuncs.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @run-at       document-idle
// @license      MIT
// @noframes
// ==/UserScript==

(function() {
  'use strict';

  var PROVIDERS = {
    qwen: {
      name: 'Qwen Cloud',
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus',
      cookieKey: 'vk-exporter-qwen-api-key'
    },
    deepseek: {
      name: 'DeepSeek',
      url: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      cookieKey: 'vk-exporter-deepseek-api-key'
    },
    openrouter: {
      name: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      cookieKey: 'vk-exporter-openrouter-api-key'
    }
  };

  var DEFAULT_PROVIDER = 'qwen';
  var PROVIDER_STORAGE_KEY = 'vk-exporter-selected-provider';
  var MAX_CHARS = 60000;
  var VK_TIMEOUT = 30000;
  var QWEN_TIMEOUT = 120000;
  var BRIDGE_NAME = 'vk-exporter-bridge';
  var PROMPT_TEMPLATES = {
    allEvents:
      'Выдели основные моменты в этой переписке с указанием ' +
      'активных участников.\n' +
      'Используй эмоджи у абзацев и глаголов для облегчения чтения.\n\n' +
      'Не пиши в начале ответа, что ты сделал. Сразу пиши ' +
      'ответ без предисловия.\n\n' +
      'Загруженные сообщения:\n\n{{TEXT}}',
    importantOnly:
      'Выдели только важные моменты в этой переписке с указанием ' +
      'активных участников. Не надо упоминать все события.\n' +
      'Используй эмоджи у абзацев и глаголов для облегчения чтения.\n\n' +
      'Не пиши в начале ответа, что ты сделал. Сразу пиши ответ ' +
      'без предисловия.\n\n' +
      'Загруженные сообщения:\n\n{{TEXT}}'
  };

  var pageWindow = typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : window;

  var bridgeRequests = {};

  installVkBridge();
  installBridgeListener();
  createLauncher();
  setInterval(updateLauncherVisibility, 500);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(
      'Запустить экспорт сообщений',
      startExporter
    );
  }

  function installVkBridge() {
          removeElement('vk-exporter-menu');
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

  function createLauncher() {
    removeElement('vk-exporter-launcher');

    var launcher = document.createElement('button');

    launcher.id = 'vk-exporter-launcher';
    launcher.type = 'button';
    launcher.textContent = '✨ Резюме';

    launcher.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:80px;' +
      'z-index:999998;' +
      'padding:10px 16px;' +
      'background:#4a76a8;' +
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
      launcher.style.background = '#3f6692';
      launcher.style.boxShadow = '0 5px 14px rgba(0,0,0,.35);';
    });
    launcher.addEventListener('mouseout', function() {
      launcher.style.background = '#4a76a8';
      launcher.style.boxShadow = 'none';
    });
    updateLauncherVisibility();
  }

  function updateLauncherVisibility() {
    var launcher = document.getElementById('vk-exporter-launcher');

    if (launcher) {
      launcher.style.display = isChatOpen()
        ? 'block'
        : 'none';
    }
  }

  function isChatOpen() {
    return /\/im\/convo\/\d+/.test(
      pageWindow.location.pathname
    );
  }

  function startExporter() {
    var modeMenu = document.getElementById(
      'vk-exporter-mode-menu'
    );

    if (modeMenu) {
      modeMenu.remove();
      return;
    }

    removeElement('vk-exporter-menu');
    removeElement('vk-exporter-status');
    removeElement('vk-exporter-result');

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

    console.log('ID из URL:', urlId);
    console.log('Используется peer_id:', peerId);

    showModeMenu(peerId);
  }

  function showModeMenu(peerId) {
    removeElement('vk-exporter-mode-menu');

    var menu = document.createElement('div');

    menu.id = 'vk-exporter-mode-menu';
    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:136px;' +
      'z-index:999999;' +
      'width:310px;' +
      'padding:16px;' +
      'background:#e8e8e8;' +
      'color:#333;' +
      'border:1px solid #ccc;' +
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
    daysInput.value = '2';
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
      loadMessages(peerId, count, null);
    });

    daysButton.addEventListener('click', function() {
      var days = Math.max(
        parseInt(daysInput.value, 10) || 2,
        1
      );

      var targetDate = Math.floor(Date.now() / 1000) -
        days * 24 * 60 * 60;

      menu.remove();
      loadMessages(peerId, null, targetDate);
    });

  }

  function createModeButton(text, color, icon) {
    var button = makeButton(text, color, icon);

    button.style.marginTop = '8px';

    return button;
  }

  function loadMessages(peerId, limit, targetDate) {
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

      console.log('Запрос messages.getHistory:', params);

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

      console.log(
        'Ответ VK API получен. Сообщений:',
        items.length
      );

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
          ? formatReplyPrefix(item.reply_message, profiles)
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
      removeElement('vk-exporter-status');

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
      removeElement('vk-exporter-status');
      alert(message);
      console.error(message);
    }
  }

  function showPromptMenu(messagesText, count, periodText) {
    removeElement('vk-exporter-prompt-menu');

    var menu = document.createElement('div');

    menu.id = 'vk-exporter-prompt-menu';
    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:72px;' +
      'z-index:999999;' +
      'width:max-content;' +
      'min-width:min(280px,calc(100vw - 40px));' +
      'max-width:calc(100vw - 40px);' +
      'padding:16px;' +
      'background:#fff;' +
      'color:#222;' +
      'border:1px solid #ddd;' +
      'border-radius:8px;' +
      'box-shadow:0 12px 24px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = 'Выберите тип резюме';
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
      '#4a76a8',
      '💯'
    );

    var importantButton = createModeButton(
      'Только важные',
      '#2d8a57',
      '⭐'
    );

    var copyMessagesButton = makeButton(
      'Копировать сообщения',
      '#e67e22',
      '📋'
    );

    var closeButton = makeButton('Закрыть', '#777', '×');

    menu.appendChild(title);
    menu.appendChild(providerLabel);
    menu.appendChild(providerSelect);
    menu.appendChild(allEventsButton);
    menu.appendChild(importantButton);
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

  function formatReplyPrefix(replyMessage, profiles) {
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
        removeElement('vk-exporter-status');
        showResult(
          restoreAuthorNames(summary, anonymized.names),
          messagesText,
          count,
          periodText
        );
      })
      .catch(function(error) {
        removeElement('vk-exporter-status');

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
    removeElement('vk-exporter-menu');

    var menu = document.createElement('div');

    menu.id = 'vk-exporter-menu';

    menu.style.cssText =
      'position:fixed;' +
      'right:20px;' +
      'bottom:72px;' +
      'z-index:999999;' +
      'width:max-content;' +
      'min-width:min(240px,calc(100vw - 40px));' +
      'max-width:calc(100vw - 40px);' +
      'padding:16px;' +
      'background:#fff;' +
      'color:#222;' +
      'border:1px solid #ddd;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.25);' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = 'Сообщений: ' + count;
    title.style.fontWeight = 'bold';
    menu.appendChild(title);

    var copyButton = makeButton(
      'Копировать сообщения',
      '#4a76a8',
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
    return makeSummary(
      messagesText,
      count,
      apiKey,
      promptTemplate,
      provider
    )
      .then(function(summary) {
        saveApiKeyCookie(provider, apiKey);
        return summary;
      })
      .catch(function(error) {
        if (!isQwenAuthError(error) || isQwenQuotaError(error)) {
          throw error;
        }

        removeApiKeyCookie(provider);

        var newApiKey = promptForApiKey(provider);

        if (!newApiKey) {
          throw new Error(
            'Для повторной попытки нужен API-ключ ' + PROVIDERS[provider].name + '.'
          );
        }

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

  function isQwenAuthError(error) {
    return error && (
      error.status === 401 ||
      error.status === 403
    );
  }

  function isQwenQuotaError(error) {
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
            QWEN_TIMEOUT / 1000 +
            ' секунд.'
          )
        );
      }, QWEN_TIMEOUT);

      try {
        var headers = {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        };

        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://vk.com';
          headers['X-Title'] = 'VK Chat AI-resumer';
        }

        GM.xmlHttpRequest({
          method: 'POST',
          url: providerConfig.url,
          timeout: QWEN_TIMEOUT,
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
                QWEN_TIMEOUT / 1000 +
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

  function fallbackCopy(text) {
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
      area.setSelectionRange(0, text.length);

      var copied = false;

      try {
        copied = document.execCommand('copy');
      } catch (error) {
        copied = false;
      }

      area.remove();

      if (copied) {
        resolve();
      } else {
        reject(
          new Error(
            'Не удалось записать текст в буфер обмена.'
          )
        );
      }
    });
  }

  function showResult(
    text,
    messagesText,
    count,
    periodText
  ) {
    removeElement('vk-exporter-result');

    var box = document.createElement('div');

    box.id = 'vk-exporter-result';

    box.style.cssText =
      'position:fixed;' +
      'left:50%;' +
      'top:50%;' +
      'transform:translate(-50%,-50%);' +
      'z-index:1000000;' +
      'width:min(700px,90vw);' +
      'padding:16px;' +
      'background:#3b7fb5;' +
      'color:#fff;' +
      'border:1px solid #2d6fa3;' +
      'border-radius:8px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.35);' +
      'box-sizing:border-box;' +
      'max-height:90vh;' +
      'overflow:hidden;' +
      'font:14px Arial,sans-serif;';

    var title = document.createElement('div');

    title.textContent = '✨ Резюме за последние ' +
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
      copyText(area.value)
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

  function makeButton(text, color, icon) {
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
      'margin-top:10px;' +
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
      '0 3px 0 rgba(0,0,0,.28),' +
      '0 5px 8px rgba(0,0,0,.18);';
    var hoverShadow =
      '0 4px 0 rgba(0,0,0,.28),' +
      '0 7px 12px rgba(0,0,0,.2);';

    button.style.boxShadow = baseShadow;
    button.style.transition =
      'background-color 0.2s ease,transform 0.12s ease,' +
      'box-shadow 0.12s ease;';

    button.addEventListener('mouseover', function() {
      button.style.boxShadow = hoverShadow;
    });

    button.addEventListener('mousedown', function() {
      button.style.transform = 'translateY(3px);';
      button.style.boxShadow = '0 1px 0 rgba(0,0,0,.28);';
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

  function showStatus(text) {
    var status = document.getElementById(
      'vk-exporter-status'
    );

    if (!status) {
      status = document.createElement('div');
      status.id = 'vk-exporter-status';

      status.style.cssText =
        'position:fixed;' +
        'right:20px;' +
        'bottom:72px;' +
        'z-index:999999;' +
        'padding:10px 14px;' +
        'background:#fff;' +
        'color:#222;' +
        'border:1px solid #ddd;' +
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
})();
