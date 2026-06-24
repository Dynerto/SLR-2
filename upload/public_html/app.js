(function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(function () {});
  }

  var ALL = "__all";
  var translations = {
    nl: {
      mainNavLabel: "Hoofdnavigatie",
      languageLabel: "Taal",
      workspaceLabel: "Instructievideo bibliotheek",
      navLibrary: "Bibliotheek",
      navAdmin: "Admin",
      libraryTitle: "Instructies",
      loadingVideos: "Video's laden...",
      searchLabel: "Zoeken",
      searchPlaceholder: "Zoek op onderwerp, tag of tekst",
      categoryLabel: "Categorie",
      durationLabel: "Duur",
      levelLabel: "Niveau",
      tagsLabel: "Tags",
      categoryFiltersLabel: "Categoriefilters",
      tagFiltersLabel: "Tagfilters",
      videosLabel: "Video's",
      selectInstruction: "Selecteer een instructie",
      selectInstructionSummary: "Kies links een video om de uitleg en stappen te bekijken.",
      explanationLabel: "Uitleg",
      all: "Alles",
      oneVideo: "1 video",
      videoCount: "{count} video's",
      noVideoFound: "Geen video gevonden.",
      noResult: "Geen resultaat",
      noResultSummary: "Pas je zoekterm of filters aan."
    },
    en: {
      mainNavLabel: "Main navigation",
      languageLabel: "Language",
      workspaceLabel: "Instruction video library",
      navLibrary: "Library",
      navAdmin: "Admin",
      libraryTitle: "Instructions",
      loadingVideos: "Loading videos...",
      searchLabel: "Search",
      searchPlaceholder: "Search by topic, tag, or text",
      categoryLabel: "Category",
      durationLabel: "Duration",
      levelLabel: "Level",
      tagsLabel: "Tags",
      categoryFiltersLabel: "Category filters",
      tagFiltersLabel: "Tag filters",
      videosLabel: "Videos",
      selectInstruction: "Select an instruction",
      selectInstructionSummary: "Choose a video on the left to view the explanation and steps.",
      explanationLabel: "Explanation",
      all: "All",
      oneVideo: "1 video",
      videoCount: "{count} videos",
      noVideoFound: "No video found.",
      noResult: "No result",
      noResultSummary: "Adjust your search term or filters."
    }
  };

  var videos = Array.isArray(window.CAPTEER_ACADEMY_VIDEOS) ? window.CAPTEER_ACADEMY_VIDEOS : [];
  var state = {
    lang: detectLanguage(),
    category: ALL,
    tag: ALL,
    query: "",
    activeId: videos[0] ? videos[0].id : null
  };

  var els = {
    count: document.getElementById("result-count"),
    search: document.getElementById("search-input"),
    categories: document.getElementById("category-filters"),
    tags: document.getElementById("tag-filters"),
    list: document.getElementById("video-list"),
    langButtons: document.querySelectorAll("[data-lang]"),
    activeCategory: document.getElementById("active-category"),
    activeDuration: document.getElementById("active-duration"),
    activeLevel: document.getElementById("active-level"),
    activeTitle: document.getElementById("active-title"),
    activeSummary: document.getElementById("active-summary"),
    activeVideo: document.getElementById("active-video"),
    activeYoutube: document.getElementById("active-youtube"),
    activeBody: document.getElementById("active-body"),
    activeTags: document.getElementById("active-tags")
  };

  applyLanguage();

  if (!els.list || !videos.length) {
    return;
  }

  bindLanguageToggle();
  bindSearch();
  renderFilters();
  render();

  function detectLanguage() {
    var saved = localStorage.getItem("capteer-academy-language");
    if (saved === "nl" || saved === "en") {
      return saved;
    }

    var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "nl"];
    return languages.some(function (language) {
      return String(language).toLowerCase().indexOf("nl") === 0;
    }) ? "nl" : "en";
  }

  function t(key) {
    return (translations[state.lang] && translations[state.lang][key]) || translations.nl[key] || key;
  }

  function applyLanguage() {
    document.documentElement.lang = state.lang;

    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (element) {
      element.textContent = t(element.dataset.i18n);
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-attr]"), function (element) {
      element.dataset.i18nAttr.split(",").forEach(function (pair) {
        var parts = pair.split(":");
        if (parts.length === 2) {
          element.setAttribute(parts[0], t(parts[1]));
        }
      });
    });

    Array.prototype.forEach.call(els.langButtons || [], function (button) {
      var active = button.dataset.lang === state.lang;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function bindLanguageToggle() {
    Array.prototype.forEach.call(els.langButtons, function (button) {
      button.addEventListener("click", function () {
        state.lang = button.dataset.lang === "en" ? "en" : "nl";
        localStorage.setItem("capteer-academy-language", state.lang);
        applyLanguage();
        renderFilters();
        render();
      });
    });
  }

  function bindSearch() {
    els.search.addEventListener("input", function () {
      state.query = els.search.value.trim().toLowerCase();
      render();
    });
  }

  function renderFilters() {
    renderFilter(els.categories, [ALL].concat(unique(videos.map(function (video) { return video.category; }))), "category");
    renderFilter(els.tags, [ALL].concat(unique(videos.reduce(function (all, video) {
      return all.concat(video.tags || []);
    }, []))), "tag");
  }

  function renderFilter(container, values, key) {
    container.innerHTML = "";

    values.forEach(function (value) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = value === ALL ? t("all") : value;
      button.dataset.value = value;
      button.addEventListener("click", function () {
        state[key] = value;
        render();
      });
      container.appendChild(button);
    });
  }

  function render() {
    updateFilterState(els.categories, state.category);
    updateFilterState(els.tags, state.tag);

    var filtered = videos.filter(matchesFilters);
    if (!filtered.some(function (video) { return video.id === state.activeId; })) {
      state.activeId = filtered[0] ? filtered[0].id : null;
    }

    els.count.textContent = filtered.length === 1 ? t("oneVideo") : t("videoCount").replace("{count}", filtered.length);
    renderList(filtered);
    renderActive(filtered);
  }

  function renderList(items) {
    els.list.innerHTML = "";

    if (!items.length) {
      var empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = t("noVideoFound");
      els.list.appendChild(empty);
      return;
    }

    items.forEach(function (video) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "lesson-card";
      button.classList.toggle("active", video.id === state.activeId);
      button.addEventListener("click", function () {
        state.activeId = video.id;
        render();
      });

      button.innerHTML =
        "<span>" + escapeHtml(video.category) + "</span>" +
        "<strong>" + escapeHtml(video.title) + "</strong>" +
        "<small>" + escapeHtml(video.duration) + " - " + escapeHtml(video.level) + "</small>";

      els.list.appendChild(button);
    });
  }

  function renderActive(items) {
    var active = items.filter(function (video) { return video.id === state.activeId; })[0];
    if (!active) {
      els.activeCategory.textContent = t("categoryLabel");
      els.activeDuration.textContent = t("durationLabel");
      els.activeLevel.textContent = t("levelLabel");
      els.activeTitle.textContent = t("noResult");
      els.activeSummary.textContent = t("noResultSummary");
      els.activeBody.textContent = "";
      els.activeTags.innerHTML = "";
      clearMedia();
      return;
    }

    els.activeCategory.textContent = active.category;
    els.activeDuration.textContent = active.duration;
    els.activeLevel.textContent = active.level;
    els.activeTitle.textContent = active.title;
    els.activeSummary.textContent = active.summary;
    els.activeBody.textContent = active.body;
    renderMedia(active);
    els.activeTags.innerHTML = "";

    (active.tags || []).forEach(function (tag) {
      var span = document.createElement("span");
      span.textContent = tag;
      els.activeTags.appendChild(span);
    });
  }

  function renderMedia(video) {
    clearMedia();

    var youtubeId = video.youtubeId || extractYoutubeId(video.youtubeUrl || video.videoSrc || "");
    if ((video.videoType === "youtube" || youtubeId) && youtubeId) {
      els.activeYoutube.src = youtubeEmbedUrl(youtubeId);
      els.activeYoutube.hidden = false;
      return;
    }

    els.activeVideo.src = video.videoSrc || "";
    els.activeVideo.hidden = false;
    els.activeVideo.load();
  }

  function clearMedia() {
    els.activeVideo.pause();
    els.activeVideo.removeAttribute("src");
    els.activeVideo.hidden = true;
    els.activeVideo.load();
    els.activeYoutube.src = "about:blank";
    els.activeYoutube.hidden = true;
  }

  function extractYoutubeId(value) {
    var text = String(value || "").trim();
    if (!text) {
      return "";
    }

    var direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
    if (direct) {
      return text;
    }

    var match = text.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : "";
  }

  function youtubeEmbedUrl(id) {
    return "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?rel=0&modestbranding=1&playsinline=1";
  }

  function matchesFilters(video) {
    var haystack = [
      video.title,
      video.category,
      video.summary,
      video.body,
      video.videoSrc,
      video.youtubeUrl,
      (video.tags || []).join(" ")
    ].join(" ").toLowerCase();

    return (state.category === ALL || video.category === state.category) &&
      (state.tag === ALL || (video.tags || []).indexOf(state.tag) !== -1) &&
      (!state.query || haystack.indexOf(state.query) !== -1);
  }

  function updateFilterState(container, activeValue) {
    Array.prototype.forEach.call(container.querySelectorAll("button"), function (button) {
      button.classList.toggle("active", button.dataset.value === activeValue);
    });
  }

  function unique(values) {
    return values.filter(Boolean).filter(function (value, index, list) {
      return list.indexOf(value) === index;
    }).sort();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();