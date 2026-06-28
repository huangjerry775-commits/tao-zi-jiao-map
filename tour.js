/**
 * 桃子腳時空膠囊導覽 — 核心互動引擎
 * 功能：互動式地圖、密碼收集、卡片資訊窗、沉浸式閱讀、成就系統、首次訪問引導
 */

(function () {
    'use strict';

    // ============================================================
    // 全域狀態
    // ============================================================
    let tourData = null;
    let activeCategory = 'all';
    let collectedPasswords = new Set();
    let currentStop = null;
    let isImmersiveOpen = false;

    // 地圖拖曳 / 縮放狀態
    let tourScale = 1.0;
    let tourTargetScale = 1.0;
    let tourX = 0, tourY = 0;
    let tourTargetX = 0, tourTargetY = 0;
    let tourDragging = false;
    let tourDragStartX = 0, tourDragStartY = 0;
    let tourIsPinching = false;
    let tourPinchStartDist = 0;
    let tourPinchStartScale = 1;

    const TOUR_LERP = 0.1;
    const MIN_SCALE = 0.3;
    const MAX_SCALE = 4.0;
    const STORAGE_KEY = 'tyk_tour_collected';
    const GUIDE_KEY = 'tyk_tour_guide_shown';
    const MAP_W = 3800;

    // ============================================================
    // 初始化
    // ============================================================
    document.addEventListener('DOMContentLoaded', async () => {
        document.body.classList.add('page-ready');
        hideLoading();
        await loadTourData();
        loadCollectedState();
        initCategoryBar();
        renderTourDots();
        initMapInteraction();
        initZoomControls();
        initInfoCard();
        initImmersiveReader();
        initPanoramaOverlay();
        showFirstVisitGuide();
        startRenderLoop();
    });

    function hideLoading() {
        requestAnimationFrame(() => {
            const ls = document.getElementById('loading-screen');
            if (ls) {
                ls.style.opacity = '0';
                setTimeout(() => { ls.style.display = 'none'; }, 600);
            }
        });
    }

    // ============================================================
    // 載入導覽資料
    // ============================================================
    async function loadTourData() {
        try {
            const res = await fetch('tour_data.json');
            if (!res.ok) throw new Error('Failed to load tour data');
            tourData = await res.json();
            updateProgress();
        } catch (e) {
            console.error('載入 tour_data.json 失敗', e);
            // 使用 fallback 資料
            tourData = { tourTitle: '校園導覽', categories: [], stops: [] };
        }
    }

    // ============================================================
    // 密碼收集狀態（localStorage）
    // ============================================================
    function loadCollectedState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                collectedPasswords = new Set(Array.isArray(arr) ? arr : []);
            }
        } catch (e) { collectedPasswords = new Set(); }
    }

    function saveCollectedState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(collectedPasswords)));
        } catch (e) { /* ignore */ }
    }

    function collectPassword(stopId) {
        if (collectedPasswords.has(stopId)) return false;
        collectedPasswords.add(stopId);
        saveCollectedState();
        updateProgress();
        return true;
    }

    function updateProgress() {
        if (!tourData) return;
        const total = tourData.stops.length;
        const collected = collectedPasswords.size;
        const fill = document.getElementById('progressFill');
        const text = document.getElementById('progressText');
        if (fill) fill.style.width = `${(collected / total) * 100}%`;
        if (text) text.textContent = `${collected} / ${total}`;
    }

    // ============================================================
    // 類別篩選列
    // ============================================================
    function initCategoryBar() {
        const bar = document.getElementById('categoryBar');
        if (!bar || !tourData) return;
        bar.innerHTML = '';

        // 全部按鈕
        const allChip = createCatChip('all', '全部', '🗺️', '#64748b', tourData.stops.length);
        allChip.classList.add('active');
        bar.appendChild(allChip);

        tourData.categories.forEach(cat => {
            const count = tourData.stops.filter(s => s.category === cat.id).length;
            if (count === 0) return;
            const chip = createCatChip(cat.id, cat.name, cat.icon, cat.color, count);
            bar.appendChild(chip);
        });
    }

    function createCatChip(id, name, icon, color, count) {
        const chip = document.createElement('button');
        chip.className = 'cat-chip';
        chip.dataset.cat = id;
        chip.style.setProperty('--cat-color', color);
        chip.innerHTML = `${icon} ${name} <span class="cat-count">${count}</span>`;
        chip.addEventListener('click', () => {
            document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            activeCategory = id;
            renderTourDots();
        });
        return chip;
    }

    // ============================================================
    // 渲染地圖上的導覽點位
    // ============================================================
    function renderTourDots() {
        const container = document.getElementById('tour-dot-container');
        if (!container || !tourData) return;
        container.innerHTML = '';

        const filtered = activeCategory === 'all'
            ? tourData.stops
            : tourData.stops.filter(s => s.category === activeCategory);

        filtered.forEach(stop => {
            const dot = document.createElement('div');
            dot.className = 'tour-dot' + (collectedPasswords.has(stop.id) ? ' collected' : '');
            dot.style.setProperty('--dot-color', stop.color);
            dot.style.left = `${stop.mapX}px`;
            dot.style.top = `${stop.mapY}px`;
            dot.dataset.stopId = stop.id;

            dot.innerHTML = `
                <div class="tour-dot-inner">${stop.icon}</div>
                <div class="tour-dot-label">${stop.title}</div>
            `;

            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                openStop(stop);
            });

            container.appendChild(dot);
        });
    }

    // ============================================================
    // 開啟建築節點
    // ============================================================
    function openStop(stop) {
        currentStop = stop;

        // 收集密碼
        const isNew = collectPassword(stop.id);

        // 更新點位外觀
        const dotEl = document.querySelector(`.tour-dot[data-stop-id="${stop.id}"]`);
        if (dotEl) dotEl.classList.add('collected');

        // 移動地圖到該點
        panToStop(stop);

        // 顯示卡片
        showInfoCard(stop);

        // 顯示成就彈窗
        if (isNew) {
            showAchievement(stop);
            // 檢查是否全部完成
            if (collectedPasswords.size === tourData.stops.length) {
                setTimeout(() => {
                    document.getElementById('completionOverlay').classList.add('show');
                }, 2500);
            }
        }
    }

    function panToStop(stop) {
        const mapArea = document.getElementById('tourMapArea');
        if (!mapArea) return;
        const rect = mapArea.getBoundingClientRect();

        tourTargetScale = stop.zoom || 1.5;
        tourTargetX = (MAP_W / 2 - stop.mapX) * tourTargetScale;
        tourTargetY = (MAP_W * getMapRatio() / 2 - stop.mapY) * tourTargetScale;
    }

    function getMapRatio() {
        const img = document.getElementById('tourMapImg');
        if (img && img.naturalWidth) return img.naturalHeight / img.naturalWidth;
        return 0.83;
    }

    // ============================================================
    // 資訊卡片
    // ============================================================
    function showInfoCard(stop) {
        const card = document.getElementById('tourInfoCard');
        const cover = document.getElementById('tourCardCover');
        const body = document.getElementById('tourCardBody');
        if (!card || !cover || !body) return;

        // 封面
        const catInfo = (tourData.categories || []).find(c => c.id === stop.category);
        if (stop.coverImage) {
            cover.innerHTML = `
                <img src="${stop.coverImage}" alt="${stop.title}">
                <span class="cover-badge">${catInfo ? catInfo.icon + ' ' + catInfo.name : ''}</span>
                <button class="cover-close" id="cardCloseBtn">✕</button>
            `;
        } else {
            cover.innerHTML = `
                <div class="cover-placeholder" style="--card-color:${stop.color}">${stop.icon}</div>
                <span class="cover-badge">${catInfo ? catInfo.icon + ' ' + catInfo.name : ''}</span>
                <button class="cover-close" id="cardCloseBtn">✕</button>
            `;
        }

        // 內容
        const isCollected = collectedPasswords.has(stop.id);
        body.innerHTML = `
            <div class="tour-card-title">${stop.title}</div>
            <div class="tour-card-subtitle" style="--card-color:${stop.color}">${stop.subtitle}</div>
            <div class="tour-card-story">${stop.story}</div>
            ${stop.funFact ? `
            <div class="tour-card-funfact">
                <div class="funfact-label">💡 趣味小知識</div>
                <div class="funfact-text">${stop.funFact}</div>
            </div>
            ` : ''}
            <div class="tour-card-actions">
                <button class="tour-card-btn primary" id="cardImmersiveBtn" style="--card-color:${stop.color}">
                    📖 沉浸式閱讀
                </button>
                ${stop.images && stop.images.length > 0 ? `
                <button class="tour-card-btn secondary" id="card360Btn">
                    🌀 360 全景
                </button>
                ` : ''}
            </div>
            ${isCollected ? '<div style="text-align:center;color:#fbbf24;font-size:12px;margin-top:8px;">✅ 密碼已收集</div>' : ''}
        `;

        // 關閉按鈕
        const closeBtn = document.getElementById('cardCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeInfoCard);

        // 沉浸式閱讀按鈕
        const immBtn = document.getElementById('cardImmersiveBtn');
        if (immBtn) immBtn.addEventListener('click', () => openImmersiveReader(stop));

        // 360 全景按鈕
        const panoBtn = document.getElementById('card360Btn');
        if (panoBtn) panoBtn.addEventListener('click', () => {
            if (stop.images && stop.images.length > 0) {
                openTourPanorama(stop.images[0]);
            }
        });

        // 開啟卡片
        card.classList.add('open');
    }

    function closeInfoCard() {
        const card = document.getElementById('tourInfoCard');
        if (card) card.classList.remove('open');
        currentStop = null;
    }

    function initInfoCard() {
        // 點擊卡片外部關閉
        document.addEventListener('click', (e) => {
            const card = document.getElementById('tourInfoCard');
            if (!card || !card.classList.contains('open')) return;
            if (card.contains(e.target)) return;
            if (e.target.closest('.tour-dot')) return;
            closeInfoCard();
        });
    }

    // ============================================================
    // 沉浸式閱讀模式
    // ============================================================
    function openImmersiveReader(stop) {
        const reader = document.getElementById('immersiveReader');
        const container = document.getElementById('immersiveScrollContainer');
        const title = document.getElementById('immersiveTitle');
        if (!reader || !container) return;

        isImmersiveOpen = true;
        title.textContent = stop.title;
        container.innerHTML = '';

        // 建立幻燈片
        const slides = [];

        // 第一頁：封面 + 簡介
        slides.push(createImmersiveSlide(stop, `走進「${stop.title}」`, stop.brief, stop.coverImage));

        // 第二頁：完整故事
        slides.push(createImmersiveSlide(stop, stop.title, stop.story, null));

        // 額外圖片頁
        if (stop.images && stop.images.length > 0) {
            stop.images.forEach((img, i) => {
                slides.push(createImmersiveSlide(stop, `📷 區域 ${i + 1}`, `這是「${stop.title}」的實景照片。`, img));
            });
        }

        // 趣味小知識頁
        if (stop.funFact) {
            slides.push(createImmersiveSlide(stop, '💡 趣味小知識', stop.funFact, null, true));
        }

        slides.forEach(slide => container.appendChild(slide));

        // 建立導航圓點
        const dotsContainer = document.getElementById('immersiveNavDots');
        dotsContainer.innerHTML = '';
        slides.forEach((_, i) => {
            const dot = document.createElement('div');
            dot.className = 'immersive-nav-dot' + (i === 0 ? ' active' : '');
            dot.addEventListener('click', () => {
                container.children[i]?.scrollIntoView({ behavior: 'smooth', inline: 'start' });
            });
            dotsContainer.appendChild(dot);
        });

        // 更新導航按鈕
        updateImmersiveNav(0, slides.length);

        // 監聽滾動更新圓點
        container.addEventListener('scroll', () => {
            const scrollLeft = container.scrollLeft;
            const slideWidth = container.clientWidth;
            const activeIdx = Math.round(scrollLeft / slideWidth);
            updateImmersiveNav(activeIdx, slides.length);
        });

        reader.classList.add('active');
    }

    function createImmersiveSlide(stop, heading, text, imageUrl, isFunFact = false) {
        const slide = document.createElement('div');
        slide.className = 'immersive-slide';

        const catInfo = (tourData.categories || []).find(c => c.category === stop.category);

        if (imageUrl) {
            slide.innerHTML = `
                <div class="immersive-slide-image">
                    <img src="${imageUrl}" alt="${heading}">
                </div>
                <div class="immersive-slide-text" style="--card-color:${stop.color}">
                    <h3>${heading}</h3>
                    <div class="slide-subtitle">${stop.subtitle || ''}</div>
                    <p>${text}</p>
                </div>
            `;
        } else if (isFunFact) {
            slide.innerHTML = `
                <div class="immersive-slide-image">
                    <div class="slide-placeholder" style="--card-color:${stop.color}">${stop.icon}</div>
                </div>
                <div class="immersive-slide-text" style="--card-color:${stop.color}">
                    <h3>${heading}</h3>
                    <div class="slide-subtitle">${stop.subtitle || ''}</div>
                    <div style="background:rgba(251,191,36,0.08);border-left:3px solid #fbbf24;padding:16px 20px;border-radius:0 12px 12px 0;">
                        <p style="color:#e2e8f0;">${text}</p>
                    </div>
                </div>
            `;
        } else {
            slide.innerHTML = `
                <div class="immersive-slide-image">
                    <div class="slide-placeholder" style="--card-color:${stop.color}">${stop.icon}</div>
                </div>
                <div class="immersive-slide-text" style="--card-color:${stop.color}">
                    <h3>${heading}</h3>
                    <div class="slide-subtitle">${stop.subtitle || ''}</div>
                    <p>${text}</p>
                </div>
            `;
        }

        return slide;
    }

    function updateImmersiveNav(activeIdx, total) {
        const dots = document.querySelectorAll('.immersive-nav-dot');
        dots.forEach((d, i) => d.classList.toggle('active', i === activeIdx));

        const prevBtn = document.getElementById('immersivePrevBtn');
        const nextBtn = document.getElementById('immersiveNextBtn');
        if (prevBtn) prevBtn.disabled = activeIdx === 0;
        if (nextBtn) nextBtn.disabled = activeIdx >= total - 1;
    }

    function initImmersiveReader() {
        const closeBtn = document.getElementById('immersiveCloseBtn');
        const prevBtn = document.getElementById('immersivePrevBtn');
        const nextBtn = document.getElementById('immersiveNextBtn');
        const container = document.getElementById('immersiveScrollContainer');

        if (closeBtn) closeBtn.addEventListener('click', closeImmersiveReader);
        if (prevBtn) prevBtn.addEventListener('click', () => {
            if (!container) return;
            const w = container.clientWidth;
            container.scrollBy({ left: -w, behavior: 'smooth' });
        });
        if (nextBtn) nextBtn.addEventListener('click', () => {
            if (!container) return;
            const w = container.clientWidth;
            container.scrollBy({ left: w, behavior: 'smooth' });
        });
    }

    function closeImmersiveReader() {
        const reader = document.getElementById('immersiveReader');
        if (reader) reader.classList.remove('active');
        isImmersiveOpen = false;
    }

    // ============================================================
    // 360 全景
    // ============================================================
    function openTourPanorama(imageUrl) {
        const overlay = document.getElementById('tourPanoramaOverlay');
        const viewerEl = document.getElementById('tour-panorama-viewer');
        if (!overlay || !viewerEl) return;

        const url = imageUrl.startsWith('uploads/') ? imageUrl : `uploads/${imageUrl}`;
        overlay.classList.add('active');

        try {
            pannellum.viewer('tour-panorama-viewer', {
                type: 'equirectangular',
                panorama: url,
                autoLoad: true,
                compass: false,
                showControls: true,
                hfov: 60
            });
        } catch (e) {
            console.error('360 viewer failed', e);
        }
    }

    function initPanoramaOverlay() {
        const closeBtn = document.getElementById('tourPanoClose');
        const overlay = document.getElementById('tourPanoramaOverlay');
        if (closeBtn) closeBtn.addEventListener('click', () => {
            overlay.classList.remove('active');
        });
    }

    // ============================================================
    // 成就彈窗
    // ============================================================
    function showAchievement(stop) {
        const toast = document.getElementById('achievementToast');
        const icon = document.getElementById('toastIcon');
        const title = document.getElementById('toastTitle');
        if (!toast) return;

        icon.textContent = stop.icon;
        title.textContent = `${stop.title} — 密碼已解鎖！`;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // ============================================================
    // 首訪引導
    // ============================================================
    function showFirstVisitGuide() {
        try {
            if (localStorage.getItem(GUIDE_KEY)) return;
        } catch (e) { /* ignore */ }

        const overlay = document.getElementById('tourGuideOverlay');
        const startBtn = document.getElementById('guideStartBtn');
        if (!overlay || !startBtn) return;

        overlay.classList.add('show');

        startBtn.addEventListener('click', () => {
            overlay.classList.remove('show');
            try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* ignore */ }
        });
    }

    // ============================================================
    // 地圖互動（拖曳 + 縮放）
    // ============================================================
    function initMapInteraction() {
        const mapArea = document.getElementById('tourMapArea');
        const wrapper = document.getElementById('tour-map-wrapper');
        if (!mapArea || !wrapper) return;

        // 載入圖片後初始化
        const img = document.getElementById('tourMapImg');
        if (img) {
            img.addEventListener('load', resetTourView);
            if (img.complete) resetTourView();
        }

        // 滾輪縮放
        mapArea.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.08 : 0.08;
            tourTargetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, tourTargetScale + delta));
        }, { passive: false });

        // 滑鼠拖曳
        mapArea.addEventListener('mousedown', (e) => {
            if (e.target.closest('.tour-dot')) return;
            tourDragging = true;
            tourDragStartX = e.clientX - tourTargetX;
            tourDragStartY = e.clientY - tourTargetY;
            mapArea.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!tourDragging) return;
            tourTargetX = e.clientX - tourDragStartX;
            tourTargetY = e.clientY - tourDragStartY;
        });

        window.addEventListener('mouseup', () => {
            tourDragging = false;
            const mapArea = document.getElementById('tourMapArea');
            if (mapArea) mapArea.style.cursor = 'grab';
        });

        // 觸控拖曳
        mapArea.addEventListener('touchstart', (e) => {
            if (e.target.closest('.tour-dot')) return;
            if (e.touches.length === 1) {
                tourDragging = true;
                tourDragStartX = e.touches[0].clientX - tourTargetX;
                tourDragStartY = e.touches[0].clientY - tourTargetY;
            } else if (e.touches.length === 2) {
                tourDragging = false;
                tourIsPinching = true;
                tourPinchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                tourPinchStartScale = tourTargetScale;
            }
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (tourDragging && e.touches.length === 1) {
                tourTargetX = e.touches[0].clientX - tourDragStartX;
                tourTargetY = e.touches[0].clientY - tourDragStartY;
            } else if (tourIsPinching && e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                tourTargetScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
                    tourPinchStartScale * (dist / tourPinchStartDist)));
            }
        }, { passive: true });

        window.addEventListener('touchend', () => {
            tourDragging = false;
            tourIsPinching = false;
        });
    }

    function resetTourView() {
        const mapArea = document.getElementById('tourMapArea');
        const img = document.getElementById('tourMapImg');
        if (!mapArea || !img) return;

        const rect = mapArea.getBoundingClientRect();
        const imgW = img.naturalWidth || MAP_W;
        const imgH = img.naturalHeight || MAP_W * 0.83;

        const fitScale = Math.min(rect.width / imgW, rect.height / imgH);
        tourScale = fitScale;
        tourTargetScale = fitScale;
        tourX = 0;
        tourY = 0;
        tourTargetX = 0;
        tourTargetY = 0;
    }

    // ============================================================
    // 縮放控制
    // ============================================================
    function initZoomControls() {
        const zoomIn = document.getElementById('tourZoomIn');
        const zoomOut = document.getElementById('tourZoomOut');
        const reset = document.getElementById('tourZoomReset');

        if (zoomIn) zoomIn.addEventListener('click', () => {
            tourTargetScale = Math.min(MAX_SCALE, tourTargetScale + 0.3);
        });
        if (zoomOut) zoomOut.addEventListener('click', () => {
            tourTargetScale = Math.max(MIN_SCALE, tourTargetScale - 0.3);
        });
        if (reset) reset.addEventListener('click', resetTourView);
    }

    // ============================================================
    // 渲染迴圈（平滑動畫）
    // ============================================================
    function startRenderLoop() {
        function frame() {
            tourScale += (tourTargetScale - tourScale) * TOUR_LERP;
            tourX += (tourTargetX - tourX) * TOUR_LERP;
            tourY += (tourTargetY - tourY) * TOUR_LERP;

            const wrapper = document.getElementById('tour-map-wrapper');
            if (wrapper) {
                wrapper.style.transform = `translate(calc(-50% + ${tourX}px), calc(-50% + ${tourY}px)) scale(${tourScale})`;
            }

            requestAnimationFrame(frame);
        }
        frame();
    }

})();