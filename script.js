const map = document.getElementById('map');
const container = document.getElementById('container') || document.querySelector('.map-container') || document.querySelector('.map-section') || document.querySelector('.main-container') || document.body;
const mapWrapper = document.getElementById('map-wrapper');

const menuBurger = document.getElementById('menuBurger');
const mobileSideMenu = document.getElementById('mobileSideMenu');
const closeMenu = document.getElementById('closeMenu');

let isDragging = false;
let startX, startY;
let isTopMap = true;
let isLocked = false;
let currentFloor = null; // 當前選中的樓層
let availableFloors = []; // 可用的樓層列表

let isPegmanModeActive = false; // 小黃人街景模式開關
let isCapturingPhotoLocation = false; // 是否正在單獨捕捉「照片拍攝點」
let panoramaViewerInstance = null;
let currentAdminMode = 'add';
let isModalAiming = false; // modal 中的地圖標記狀態


let isPinching = false;
let touchStartDist = 0;
let lastTouchScale = 1;

// 1. 請確保在 script.js 最上方有定義這兩個全域變數（如果原本就有，請不要重複定義）
let allMarkersData = []; // 存放從後端抓回來的所有標點
let isAdminMode = false; // 是否為管理員模式 (會由網頁 body 帶有的 class 自動決定)

let activePanoViewer = null;
let popupInlinePanoViewer = null;
let panoramaLoadingTimer = null;
let previewMarker = null;
let currentPanoramaPointId = null;
let currentViewer = null;
let image360Points = [];

function normalizeHotspotImages(spotOrImages) {
    const source = Array.isArray(spotOrImages)
        ? spotOrImages
        : [
            ...(Array.isArray(spotOrImages?.images) ? spotOrImages.images : []),
            ...(Array.isArray(spotOrImages?.imageFiles) ? spotOrImages.imageFiles : []),
            ...(spotOrImages?.image ? String(spotOrImages.image).split(',') : [])
        ];
    const seen = new Set();
    return source
        .map(file => String(file || '').trim())
        .filter(file => {
            if (!file || seen.has(file)) return false;
            seen.add(file);
            return true;
        });
}

// 🆕 Google Maps 式熱點標註模式
let isPinningMode = false; // 是否處於標記模式
let pendingHotspotPosition = null; // 等待確認的熱點位置 {pitch, yaw}
let floatingPinElement = null; // 懸浮標記元素
let crosshairElement = null; // 十字瞄準線元素

let targetX = 0, targetY = 0;
let currentX = 0, currentY = 0;
let targetScale = null;
let currentScale = 1.3;
const lerpFactor = 0.07;

const appStartTime = Date.now();

const API_BASE = (() => {
    if (window.location.protocol === 'file:') return 'http://localhost:3000';
    if (window.location.port === '3000') return '';
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return 'http://localhost:3000';
    }
    return '';
})();

function sanitizeUploadFileName(name) {
    return String(name || '')
        .trim()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9-_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'upload';
}

function buildDefaultUploadName(fileName) {
    const raw = String(fileName || '');
    const ext = raw.includes('.') ? raw.split('.').pop() : '';
    const base = raw.replace(/\.[^/.]+$/, '');
    return sanitizeUploadFileName(base) + (ext ? `.${ext}` : '');
}

async function uploadPendingImage(file, imageType = 'normal') {
    const formData = new FormData();
    const customFileName = document.getElementById('customFileName')?.value?.trim();
    const sanitizedCustomName = customFileName ? sanitizeUploadFileName(customFileName.replace(/\.[^/.]+$/, '')) : '';
    formData.append('panoramaImage', file);
    if (sanitizedCustomName) formData.append('customFileName', sanitizedCustomName);
    formData.append('imageType', imageType || 'normal');

    const res = await fetch(`${API_BASE}/api/upload-image`, {
        method: 'POST',
        body: formData
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.success === false) {
        throw new Error(result.message || '圖片上傳失敗');
    }
    return result;
}

// ===== map state persistence (zoom & pan) =====
function saveMapState() {
    try {
        const state = {
            targetX: targetX,
            targetY: targetY,
            targetScale: targetScale
        };
        localStorage.setItem('tyk_map_state', JSON.stringify(state));
    } catch (e) { console.warn('saveMapState failed', e); }
}

function loadMapState() {
    try {
        const raw = localStorage.getItem('tyk_map_state');
        if (!raw) return;
        const s = JSON.parse(raw);
        if (typeof s.targetScale === 'number') targetScale = s.targetScale;
        if (typeof s.targetX === 'number') targetX = s.targetX;
        if (typeof s.targetY === 'number') targetY = s.targetY;
    } catch (e) { console.warn('loadMapState failed', e); }
}

// 週期性備份地圖狀態以減少資料遺失（降低頻率減少 I/O 開銷）
setInterval(saveMapState, 3000);

// ==========================================================================
// 修正：網頁載入初始化（自動辨識管理員身份）
// ==========================================================================
// 載入動畫計時器 - 確保至少顯示 1 秒
let loaderReady = false;
let loaderMinTimePassed = false;

document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add('page-ready');

    // 載入進度條動畫 - 平滑遞增，保證至少 1 秒
    const progressFill = document.getElementById('loaderProgressFill');
    if (progressFill) {
        let progress = 0;
        const interval = setInterval(() => {
            const remaining = 100 - progress;
            // 越接近 100% 增加越慢，讓動畫更平滑自然
            const increment = Math.max(0.5, remaining * (0.08 + Math.random() * 0.12));
            progress = Math.min(progress + increment, 98); // 最多到 98%，最後 2% 由 ready 補上
            progressFill.style.width = progress + '%';
        }, 100);

        // 儲存 interval 以便後續清除
        window.__loaderInterval = interval;
    }

    // 標記最小時間已過 (1 秒)
    setTimeout(() => {
        loaderMinTimePassed = true;
        tryHideLoading();
    }, 1000);

    // ✨ 核心修正：自動判斷是不是管理員頁面（檢查畫面中有沒有管理面板 #admin-panel）
    if (document.getElementById('admin-panel')) {
        isAdminMode = true;
        // 進入管理頁面時，清除殘留的上傳暫存（避免自動彈出上傳 Modal）
        localStorage.removeItem('pendingImageToSet');
        localStorage.removeItem('pendingImageType');
        console.log("🔒 系統提示：偵測到管理控制台，已成功自動啟用管理員打點模式！");
    } else {
        isAdminMode = false;
    }

    loadMapState();
    initSlidingNavbar();
    initLeftBottomLayerMenu();
    initZoomSliderControls();

    if (typeof updateMapLimits === 'function') {
        updateMapLimits();
        if (map) map.addEventListener('load', updateMapLimits);
        window.addEventListener('load', updateMapLimits);
    }

    // 如果存在 pending 上傳的檔案（可能因為 Live Server 重整），自動打開 modal 以完成設定
    try {
        const pending = localStorage.getItem('pendingImageToSet');
        const pendingType = localStorage.getItem('pendingImageType');
        if (pending) {
            setTimeout(() => {
                const modal = document.getElementById('uploadSettingsModal');
                if (modal) {
                    try {
                        document.getElementById('modalImageFilename').value = pending;
                        document.getElementById('modalImageType').value = pendingType || 'normal';
                        document.getElementById('modalImageTitle').value = '';
                        document.getElementById('modalImageDesc').value = '';
                        document.getElementById('modalImageTags').value = '';
                        document.getElementById('modalImageFloor').value = '';
                        modal.style.display = 'flex';
                        if (pendingType === '360') {
                            const markBtn = document.getElementById('modalMarkOnMapBtn');
                            if (markBtn) markBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    } catch (e) { }
                }
            }, 250);
        }
    } catch (e) { /* ignore */ }

    // 載入永久標點與 360 點位（各自內部已有 render 與 initFloorSelector）
    // 用 Promise.all 平行載入，避免序列等待
    if (typeof loadPermanentMarkers === 'function') loadPermanentMarkers();
    if (typeof loadUploaded360Points === 'function') loadUploaded360Points();

    if (document.getElementById('admin-panel') && typeof initAdminEngine === 'function') {
        initAdminEngine();
    }
    // 綁定圖片上傳按鈕與檔案輸入
    try {
        const fileInput = document.getElementById('imageFileInput');
        const btnSelectFile = document.getElementById('btnSelectFile');
        const uploadDetails = document.getElementById('uploadDetails');
        const uploadStatusMessage = document.getElementById('uploadStatusMessage');
        const customFileNameInput = document.getElementById('customFileName');
        if (btnSelectFile && fileInput) {
            btnSelectFile.addEventListener('click', (e) => {
                e.stopPropagation();
                fileInput.click();
            });
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const modal = document.getElementById('uploadSettingsModal');
                try {
                    if (customFileNameInput) customFileNameInput.value = buildDefaultUploadName(file.name).replace(/\.[^/.]+$/, '');
                    if (uploadDetails) uploadDetails.style.display = 'block';
                    if (uploadStatusMessage) uploadStatusMessage.textContent = `已選取：${file.name}，請完成設定後儲存。`;
                    document.getElementById('modalImageFilename').value = file.name;
                    document.getElementById('modalImageType').value = '';
                    document.getElementById('modalImageTitle').value = '';
                    document.getElementById('modalImageDesc').value = '';
                    document.getElementById('modalImageTags').value = '';
                    document.getElementById('modalImageFloor').value = '';
                    if (modal) modal.style.display = 'flex';
                    localStorage.setItem('pendingImageToSet', file.name);
                    localStorage.setItem('pendingImageType', '');
                    window.__pendingImageFile = file;
                } catch (err) { console.warn('file input handling failed', err); }
            });
        }
    } catch (e) { }

    // 載入已上傳圖片列表供管理員使用
    if (typeof loadUploadedImagesList === 'function') {
        loadUploadedImagesList();
    }

    // 初始化語言切換
    initLanguageSwitcher();
});

// ==========================================================================
// 修正：滑動導覽列引擎（加上安全檢查，防止 null 錯誤）
// ==========================================================================
function initSlidingNavbar() {
    const indicator = document.getElementById('navIndicator');
    const navLinks = document.querySelectorAll('.nav-links a');
    const niceTransition = 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)';

    // 找到當前頁面對應的 active link
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    let activeLink = document.querySelector('.nav-links a.active');
    if (!activeLink) {
        activeLink = document.querySelector(`.nav-links a[href="${currentPage}"]`);
    }

    function updateIndicator(el) {
        if (!indicator || !el) return;
        // 使用 getBoundingClientRect 精確計算位置
        const navRect = el.closest('.nav-links')?.getBoundingClientRect();
        const linkRect = el.getBoundingClientRect();
        if (navRect) {
            indicator.style.width = `${linkRect.width}px`;
            indicator.style.left = `${linkRect.left - navRect.left}px`;
        } else {
            indicator.style.width = `${el.offsetWidth}px`;
            indicator.style.left = `${el.offsetLeft}px`;
        }
    }

    if (indicator && activeLink) {
        indicator.style.transition = 'none';
        updateIndicator(activeLink);
        requestAnimationFrame(() => {
            indicator.style.transition = niceTransition;
        });
    }

    navLinks.forEach(link => {
        link.addEventListener('click', function (e) {
            const destination = this.getAttribute('href');
            if (destination && destination !== '#') {
                e.preventDefault();

                updateIndicator(this);

                navLinks.forEach(a => a.classList.remove('active'));
                this.classList.add('active');

                setTimeout(() => {
                    document.body.style.opacity = '0';
                    setTimeout(() => { window.location.href = destination; }, 350);
                }, 150);
            }
        });
    });

    // 視窗大小改變時重新校正 indicator 位置
    window.addEventListener('resize', () => {
        const currentActive = document.querySelector('.nav-links a.active');
        if (indicator && currentActive) {
            updateIndicator(currentActive);
        }
    });
}

function initLeftBottomLayerMenu() {
    const btn = document.getElementById('layerMenuBtn');
    const menu = document.getElementById('layerPopupMenu');
    const workToggleBtn = document.getElementById('btnToggleLayer');

    if (workToggleBtn) {
        workToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isTopMap = !isTopMap;
            map.src = isTopMap ? './page_picture/TYK_map_top.jpg' : './page_picture/TYK_map.jpg';
            workToggleBtn.textContent = isTopMap ? '切換圖層 🔺' : '切換圖層 🔻';
            closeGlobalPopup();
            renderAllMarkers();
        });
    }

    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        menu.classList.remove('show');
    });

    document.querySelectorAll('.layer-menu-item').forEach(item => {
        item.addEventListener('click', function () {
            document.querySelectorAll('.layer-menu-item').forEach(i => i.classList.remove('active'));
            this.classList.add('active');

            const layerType = this.dataset.layer;
            isTopMap = (layerType === 'top');
            map.src = isTopMap ? './page_picture/TYK_map_top.jpg' : './page_picture/TYK_map.jpg';

            closeGlobalPopup();
            renderAllMarkers();
        });
    });
}

function initFloorSelector() {
    const floors = new Set();
    const allPossibleMarkers = [...markerDataArray, ...allMarkersData, ...image360Points];
    allPossibleMarkers.forEach(marker => {
        if (marker && marker.floor) {
            floors.add(marker.floor);
        }
    });

    availableFloors = Array.from(floors).sort();

    // 優先使用新的樓層按鈕結構（layerFloorBtns）
    const layerFloorBtns = document.getElementById('layerFloorBtns');

    if (layerFloorBtns && availableFloors.length > 0) {
        // 動態生成樓層按鈕
        layerFloorBtns.innerHTML = '';

        // 全部樓層按鈕
        const allBtn = document.createElement('button');
        allBtn.className = 'layer-floor-btn active';
        allBtn.dataset.floor = '';
        allBtn.textContent = '全部';
        allBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentFloor = null;
            layerFloorBtns.querySelectorAll('.layer-floor-btn').forEach(b => b.classList.remove('active'));
            allBtn.classList.add('active');
            renderAllMarkers();
        });
        layerFloorBtns.appendChild(allBtn);

        // 各樓層按鈕
        availableFloors.forEach(floor => {
            const btn = document.createElement('button');
            btn.className = 'layer-floor-btn';
            btn.dataset.floor = floor;
            btn.textContent = floor;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                currentFloor = floor;
                layerFloorBtns.querySelectorAll('.layer-floor-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderAllMarkers();
            });
            layerFloorBtns.appendChild(btn);
        });
    }

    // 相容舊版結構
    const floorPanel = document.getElementById('floorControlPanel');
    const floorMenu = document.getElementById('floorPopupMenu');
    const floorMenuBtn = document.getElementById('floorMenuBtn');

    if (availableFloors.length === 0 && !layerFloorBtns) {
        if (floorPanel) floorPanel.style.display = 'none';
        return;
    }

    if (floorPanel && !layerFloorBtns) floorPanel.style.display = 'flex';

    if (floorMenu && !layerFloorBtns) {
        floorMenu.innerHTML = '';
        const allBtn = document.createElement('button');
        allBtn.className = 'floor-menu-item active';
        allBtn.dataset.floor = '';
        allBtn.textContent = '📂 全部樓層';
        allBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            currentFloor = null;
            document.querySelectorAll('.floor-menu-item').forEach(b => b.classList.remove('active'));
            allBtn.classList.add('active');
            renderAllMarkers();
        });
        floorMenu.appendChild(allBtn);

        availableFloors.forEach(floor => {
            const btn = document.createElement('button');
            btn.className = 'floor-menu-item';
            btn.dataset.floor = floor;
            btn.textContent = `📂 ${floor}`;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                currentFloor = floor;
                document.querySelectorAll('.floor-menu-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (floorMenuBtn) {
                    floorMenuBtn.innerHTML = `${floor} <span style="font-size:10px;">▼</span>`;
                }
                renderAllMarkers();
            });
            floorMenu.appendChild(btn);
        });
    }

    if (floorMenuBtn && !layerFloorBtns) {
        floorMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (floorMenu) floorMenu.classList.toggle('show');
        });
    }
    if (!layerFloorBtns) {
        document.addEventListener('click', () => {
            if (floorMenu) floorMenu.classList.remove('show');
        });
    }
}

function initZoomSliderControls() {
    const slider = document.getElementById('zoomSlider');
    const zoomIn = document.getElementById('zoomInBtn');
    const zoomOut = document.getElementById('zoomOutBtn');

    if (slider) {
        slider.addEventListener('input', (e) => {
            targetScale = parseFloat(e.target.value);
            updateMapLimits();
        });
    }
    if (zoomIn) {
        zoomIn.addEventListener('click', () => {
            targetScale += 0.3;
            updateMapLimits();
        });
    }
    if (zoomOut) {
        zoomOut.addEventListener('click', () => {
            targetScale -= 0.3;
            updateMapLimits();
        });
    }
}

function updateMapLimits() {
    if (!map || !container) return;

    const rect = container.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const mapW = map.naturalWidth || map.offsetWidth || 3800;
    const mapH = map.naturalHeight || map.offsetHeight || 2800;
    const isMobile = window.innerWidth <= 992;
    const navbarHeight = isMobile ? 80 : 90;
    const isPageLevelContainer = container === document.body
        || container.id === 'container'
        || container.classList.contains('map-container');
    const availableHeight = Math.max(rect.height - (isPageLevelContainer ? navbarHeight : 0), 1);

    const fitScale = Math.min(rect.width / mapW, availableHeight / mapH);
    const minScale = Math.max(fitScale * 0.45, 0.25);
    const maxScale = 4.0;

    if (targetScale === null || !Number.isFinite(targetScale)) {
        targetScale = Math.max(fitScale, minScale);
        targetX = 0;
        targetY = isPageLevelContainer ? (navbarHeight / 2) : 0;
        currentY = targetY;
    }

    targetScale = Math.max(minScale, Math.min(targetScale, maxScale));

    const slider = document.getElementById('zoomSlider');
    if (slider) {
        slider.min = minScale.toFixed(2);
        slider.max = maxScale.toFixed(2);
        slider.value = targetScale.toFixed(2);
    }

    const curW = mapW * targetScale;
    const curH = mapH * targetScale;
    const boundX = Math.max((curW - rect.width) / 2, 0);
    const boundY = Math.max((curH - availableHeight) / 2, 0);

    targetX = Math.min(Math.max(targetX, -boundX), boundX);
    targetY = Math.min(Math.max(targetY, -boundY), boundY);

    if (curH <= availableHeight) {
        targetX = 0;
        targetY = isPageLevelContainer ? (navbarHeight / 2) : 0;
    }
}

function render() {
    currentX += (targetX - currentX) * lerpFactor;
    currentY += (targetY - currentY) * lerpFactor;
    currentScale += (targetScale - currentScale) * lerpFactor;

    if (mapWrapper) {
        mapWrapper.style.transform = `translate(calc(-50% + ${currentX}px), calc(-50% + ${currentY}px)) scale(${currentScale})`;
    }

    const slider = document.getElementById('zoomSlider');
    if (slider && document.activeElement !== slider) {
        slider.value = targetScale;
    }

    requestAnimationFrame(render);
}
updateMapLimits();
render();

if (menuBurger) menuBurger.addEventListener('click', () => { mobileSideMenu.classList.add('open'); });
if (closeMenu) closeMenu.addEventListener('click', () => { mobileSideMenu.classList.remove('open'); });

window.addEventListener('resize', updateMapLimits);
window.addEventListener('wheel', (e) => {
    if (e.target.closest('.global-popup-card') || e.target.closest('.admin-sidebar') || e.target.closest('#admin-panel')) return;

    e.preventDefault();
    targetScale += (e.deltaY > 0 ? -0.06 : 0.06);
    updateMapLimits();
}, { passive: false });

window.addEventListener('mousedown', (e) => {
    if (e.target.closest('.shape-navbar') ||
        e.target.closest('.layer-control-panel') ||
        e.target.closest('.zoom-control-panel') ||
        e.target.closest('.mobile-side-menu') ||
        e.target.closest('.global-popup-card') ||
        e.target.closest('.custom-layer-marker') ||
        e.target.closest('.admin-sidebar') ||
        e.target.closest('#admin-panel')) return;

    isDragging = true;
    startX = e.clientX - targetX;
    startY = e.clientY - targetY;
});

window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    targetX = e.clientX - startX;
    targetY = e.clientY - startY;
    updateMapLimits();
});

window.addEventListener('mouseup', () => { isDragging = false; });
window.addEventListener('mouseleave', () => { isDragging = false; });

window.addEventListener('touchstart', (e) => {
    if (e.target.closest('.shape-navbar') ||
        e.target.closest('.layer-control-panel') ||
        e.target.closest('.zoom-control-panel') ||
        e.target.closest('.mobile-side-menu') ||
        e.target.closest('.global-popup-card') ||
        e.target.closest('.hotspot-popup-card') ||
        e.target.closest('.custom-layer-marker') ||
        e.target.closest('.admin-sidebar') ||
        e.target.closest('#admin-panel')) return;

    if (e.touches.length === 1) {
        e.preventDefault();
        isDragging = true;
        startX = e.touches[0].clientX - targetX;
        startY = e.touches[0].clientY - targetY;
    } else if (e.touches.length === 2) {
        e.preventDefault();
        isDragging = false;
        isPinching = true;
        touchStartDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        lastTouchScale = targetScale;
    }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
        e.preventDefault();
        targetX = e.touches[0].clientX - startX;
        targetY = e.touches[0].clientY - startY;
        updateMapLimits();
    } else if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = dist / touchStartDist;
        targetScale = lastTouchScale * factor;
        updateMapLimits();
    }
}, { passive: false });

window.addEventListener('touchend', () => {
    isDragging = false;
    isPinching = false;
});

window.addEventListener('click', (e) => {
    if (isDragging) return;
    if (e.target.closest('.custom-layer-marker') || e.target.closest('.global-popup-card')) return;
    closeGlobalPopup();
});

function closeGlobalPopup() {
    const popup = document.getElementById('global-map-popup');
    if (popup) popup.classList.remove('active', 'fullscreen');
    document.body.classList.remove('global-popup-fullscreen-active');
    isLocked = false;
    if (activePanoViewer) {
        activePanoViewer.destroy();
        activePanoViewer = null;
    }
    if (popupInlinePanoViewer) {
        popupInlinePanoViewer.destroy();
        popupInlinePanoViewer = null;
    }
}

/* 核心座標庫已移至後端 markers.json，前端改為全資料庫驅動 */
const markerDataArray = [];

function renderAllMarkers() {
    const markerContainer = document.getElementById('marker-container');
    if (!markerContainer) return;
    markerContainer.innerHTML = ''; // 清空舊的點，避免重複生成
    markerContainer.innerHTML = ''; // 清空舊的點，避免重複生成

    // 確保 marker-container 高度等於地圖圖片高度
    if (map) {
        const mapH = map.offsetHeight || map.naturalHeight || 2800;
        markerContainer.style.height = mapH + 'px';
    }


    let popup = document.getElementById('global-map-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'global-map-popup';
        popup.className = 'global-popup-card';
        document.body.appendChild(popup);
    }

    const currentLayerName = isTopMap ? 'TYK_map_top' : 'TYK_map';

    // 合併預設地標與自訂點位
    const combinedMarkers = [...markerDataArray, ...allMarkersData];

    combinedMarkers.forEach(data => {
        // 標準化圖層名稱
        let mLayer = data.layer;
        if (mLayer === 'top') mLayer = 'TYK_map_top';
        if (mLayer === 'base') mLayer = 'TYK_map';

        if (mLayer !== currentLayerName) return;

        // 樓層過濾：如果設置了當前樓層且標點有樓層資訊，則需要匹配
        if (currentFloor && data.floor && data.floor !== currentFloor) return;

        if (isPegmanModeActive) return; // 360 模式下只顯示專用 360 上傳點，不要一般標點

        // 建立地圖上的小地標圓點
        const marker = document.createElement('div');
        const markerShape = data.shape || 'square';
        marker.className = `custom-layer-marker marker-shape-${markerShape}`;
        marker.style.position = 'absolute';

        // Legacy 相容：自動偵測並將舊百分比座標（<100）轉換為像素座標
        let posX = data.x;
        let posY = data.y;
        if (data.x < 100) {
            posX = (data.x / 100) * 3800;
        }
        if (data.y < 100) {
            const ratio = (map && map.naturalWidth) ? (map.naturalHeight / map.naturalWidth) : 0.8;
            posY = (data.y / 100) * (3800 * ratio);
        }

        marker.style.left = `${posX}px`;
        marker.style.top = `${posY}px`;
        // 【修正 1】增加 transform 確保點位中心對齊，解決滑鼠觸發時因偏移造成的座標跳動
        marker.style.transform = 'translate(-50%, -50%)';
        marker.innerText = data.label || (data.title ? data.title.charAt(0) : '📍');
        marker.dataset.layer = mLayer;
        marker.style.pointerEvents = 'auto';

        // 給自訂點位管理員看的特殊視覺提示
        const isBackendMarker = allMarkersData.some(m => m.id === data.id);
        if (isAdminMode && isBackendMarker) {
            marker.style.border = '13px solid #ff9f43';
            marker.style.boxShadow = '0 0 15px #ff9f43';
        }

        marker.addEventListener('mouseenter', () => {
            if (isLocked) return;
            injectPopupContent(popup, data, false);
            popup.classList.add('active');
        });

        marker.addEventListener('mouseleave', () => {
            if (isLocked) return;
            popup.classList.remove('active');
        });

        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault(); // 防止預設行為

            if (isAdminMode && isBackendMarker && currentAdminMode !== 'image') {
                // 管理員模式邏輯維持不變
                // (如果您需要這裡也保持不移動，請確認此區塊內沒有修改 targetX/Y)
            } else {
                // 【已移除移動邏輯】點擊熱點後，地圖不會飛走、不會鎖定，也不會強行對準座標

                // 執行彈出視窗顯示
                injectPopupContent(popup, data, true);
                popup.classList.add('active');
            }



            if (isAdminMode && isBackendMarker && currentAdminMode !== 'image') {
                // 【管理員點擊舊點】：把舊資料倒回表單
                document.getElementById('markerId').value = data.id;
                document.getElementById('markerTitle').value = data.title || '';
                document.getElementById('markerDesc').value = data.desc || '';
                document.getElementById('markerLabel').value = data.label || '';
                document.getElementById('markerFloor').value = data.floor || '';
                document.getElementById('markerX').value = data.x;
                document.getElementById('markerY').value = data.y;

                const zoomInput = document.getElementById('markerZoomScale');
                if (zoomInput) {
                    zoomInput.value = data.zoom || 1.5;
                }

                const staticDelBtn = document.getElementById('btnDeleteMarker');
                if (staticDelBtn) {
                    staticDelBtn.style.display = 'block';
                }

                const selectMarker = document.getElementById('selectMarkerToEdit');
                if (selectMarker) {
                    selectMarker.value = data.id;
                }

                alert(`已選取點位【 ${data.title} 】。您可以在面板修改文字、照片或放大倍率，改完後點擊儲存即可！`);

            } else {
                // 【一般訪客或非自訂地標點擊】

                isLocked = true;

                // ✨ 先顯示標題+描述骨架，動畫播完才載入圖片
                popup.innerHTML = `
                    <div class="popup-header">
                        <div class="popup-header-title">
                            <strong>${data.title || ''}</strong>
                            <button class="popup-fullscreen-btn" id="popupFullscreenBtn" title="切換全螢幕">⤢</button>
                        </div>
                        <button class="popup-close-btn" id="popupCloseX">×</button>
                    </div>
                    <div class="popup-description">${data.desc || ''}</div>
                    <div style="padding:20px;text-align:center;color:#94a3b8;font-size:13px;">⏳ 圖片載入中，請稍候…</div>
                `;
                popup.classList.add('active');

                const closeBtn = document.getElementById('popupCloseX');
                if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeGlobalPopup(); });
                const fsBtn = document.getElementById('popupFullscreenBtn');
                if (fsBtn) fsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleGlobalPopupFullscreen(); });

                const specificZoom = parseFloat(data.zoom) || 1.5;
                targetScale = specificZoom;

                const mapW = map.offsetWidth;
                const mapH = map.offsetHeight;
                const isMobile = window.innerWidth <= 992;
                const navbarHeight = isMobile ? 80 : 90;
                const isPageLevelContainer = container === document.body
                    || container.id === 'container'
                    || container.classList.contains('map-container');

                targetX = (mapW / 2 - posX) * targetScale;
                targetY = (mapH / 2 - posY) * targetScale + (isPageLevelContainer ? (navbarHeight / 2) : 0);
                updateMapLimits();

                // ✨ 延遲 700ms 載入完整內容（含圖片、360 檢視器）
                if (window._popupImageTimer) clearTimeout(window._popupImageTimer);
                window._popupImageTimer = setTimeout(() => {
                    injectPopupContent(popup, data, true);
                    window._popupImageTimer = null;
                }, 700);
            }
        });

        markerContainer.appendChild(marker);
    });

    // 顯示 360 點位（管理員或一般模式，只要 isPegmanModeActive 就顯示）
    if (isPegmanModeActive && image360Points.length) {
        image360Points.forEach(data => {
            if (currentFloor && data.floor && data.floor !== currentFloor) return;
            const marker = document.createElement('div');
            marker.className = 'custom-layer-marker image-360-marker';
            marker.style.position = 'absolute';

            let posX = data.x;
            let posY = data.y;
            if (data.x < 100) {
                posX = (data.x / 100) * 3800;
            }
            if (data.y < 100) {
                const ratio = (map && map.naturalWidth) ? (map.naturalHeight / map.naturalWidth) : 0.8;
                posY = (data.y / 100) * (3800 * ratio);
            }

            marker.style.left = `${posX}px`;
            marker.style.top = `${posY}px`;

            // 【修正 1】增加這行，強制將標記圓心與座標點對齊
            marker.style.transform = 'translate(-50%, -50%)';

            marker.innerText = '';
            marker.title = data.title || '360 全景點';
            marker.dataset.type = 'uploaded360';
            marker.style.pointerEvents = 'auto';

            marker.addEventListener('click', (e) => {
                // 【修正 2】阻止事件傳遞與預設行為
                e.stopPropagation();
                e.preventDefault();

                const panoUrl = resolvePanoUrl(data.panoUrl || '');
                if (panoUrl) {
                    openPanoramaMode(panoUrl, data.id);
                } else {
                    // 這裡如果是普通點位，顯示您的彈窗
                    injectPopupContent(popup, data, true);
                    popup.classList.add('active');
                }
            });

            markerContainer.appendChild(marker);
        });
    }
}

function resolvePanoUrl(url) {
    if (!url) return '';
    // 已經是完整 URL
    if (/^https?:\/\//i.test(url)) return url;
    // 已經是絕對路徑或相對路徑
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.includes('\\')) return url;
    // 包含 uploads 前綴
    if (url.startsWith('uploads/')) return url;
    // 純檔名 → 組合成 uploads/ 路徑
    return `${API_BASE}/uploads/${url}`;
}

function getStoredImageType(fileName) {
    if (!fileName) return '';
    const normalized = getImageFileName(fileName);
    const source = window.__uploadedImageMetaCache || {};
    const meta = source[normalized] || source[fileName] || {};
    return meta.type || meta.imageType || '';
}

function getImageFileName(source) {
    return String(source || '').split('/').pop().split('?')[0];
}

function resolve360FileName(source) {
    const raw = getImageFileName(source);
    if (raw.startsWith('360img-')) return raw.slice('360img-'.length);
    return raw;
}

function is360ImageFile(source) {
    const fileName = getImageFileName(source);
    if (!fileName) return false;
    try {
        return getStoredImageType(fileName) === '360';
    } catch {
        return false;
    }
}

function ensurePanoramaLoadingOverlay() {
    const overlay = document.getElementById('panorama-overlay');
    if (!overlay) return null;

    let loading = document.getElementById('panorama-loading-overlay');
    if (loading) return loading;

    loading = document.createElement('div');
    loading.id = 'panorama-loading-overlay';
    loading.className = 'panorama-loading-overlay active';
    loading.innerHTML = `
        <div class="panorama-loading-card">
            <div class="panorama-loading-spinner" aria-hidden="true"></div>
            <div class="panorama-loading-copy">
                <div class="panorama-loading-title">載入全景中</div>
                <div class="panorama-loading-subtitle">請稍候，正在建立 360 視角</div>
            </div>
        </div>
    `;
    overlay.appendChild(loading);
    return loading;
}

function hidePanoramaLoadingOverlay() {
    const loading = document.getElementById('panorama-loading-overlay');
    if (loading) loading.classList.remove('active');
    if (panoramaLoadingTimer) {
        clearTimeout(panoramaLoadingTimer);
        panoramaLoadingTimer = null;
    }
}

async function loadUploaded360Points() {
    try {
        const [imagesRes, metaRes] = await Promise.all([
            fetch(`${API_BASE}/api/get-uploaded-images`),
            fetch(`${API_BASE}/api/get-image-meta`)
        ]);
        if (!imagesRes.ok || !metaRes.ok) return;

        const images = await imagesRes.json();
        const meta = await metaRes.json();
        image360Points = [];

        if (!Array.isArray(images)) return;

        images.forEach(filename => {
            const data = meta?.[filename] || {};
            const type = data.type || getStoredImageType(filename);
            if (type !== '360') return;
            const x = parseInt(data.photoX || data.modalPhotoX || data.photoLocationX || data.x || '0', 10);
            const y = parseInt(data.photoY || data.modalPhotoY || data.photoLocationY || data.y || '0', 10);
            if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return;

            image360Points.push({
                id: `360img-${filename}`,
                title: data.title || filename,
                desc: data.desc || '',
                floor: data.floor || '',
                panoUrl: filename,
                x,
                y,
                zoom: parseFloat(data.defaultZoom) || 1.5,
                is360: true,
                isUploaded360: true
            });
        });

        renderAllMarkers();
        if (typeof initFloorSelector === 'function') {
            initFloorSelector();
        }
    } catch (err) {
        console.warn('載入上傳 360 點位失敗：', err);
    }
}

// 載入 360 圖片的熱點
async function loadHotspotsFor360Image(filename) {
    try {
        const res = await fetch(`${API_BASE}/api/hotspots/${encodeURIComponent(filename)}`);
        if (!res.ok) return [];
        return await res.json();
    } catch (err) {
        console.warn('載入熱點失敗:', err);
        return [];
    }
}

function buildPannellumHotspotConfig(spot, index) {
    // 獲取標籤，如果為空則回傳 null，由 CSS min-width 撐開成圓形
    const label = (spot.text && String(spot.text).trim()) ? String(spot.text).trim() : null;
    const id = spot.id || `hotspot-${index}`;
    let lastActivationAt = 0;

    function activateHotspot(event) {
        if (event && typeof event.stopPropagation === 'function') {
            event.stopPropagation();
        }
        const now = Date.now();
        if (now - lastActivationAt < 250) return;
        lastActivationAt = now;

        if (spot.type === 'scene' && spot.targetScene) {
            focusHotspotInViewer(spot, true, 42);
            // 導覽型：切換至目標 360 全景
            if (typeof openPanoramaMode === 'function') {
                openPanoramaMode(resolvePanoUrl(spot.targetScene), spot.targetScene);
            }
        } else {
            focusHotspotInViewer(spot, true, 42);
            // 資訊型：觸發浮動視窗邏輯
            if (typeof showHotspotPopup === 'function') {
                showHotspotPopup(
                    spot.title || spot.text || '說明',
                    spot.content || spot.desc || spot.text || '',
                    normalizeHotspotImages(spot),
                    spot
                );
            } else {
                const popup = document.querySelector('.hotspot-popup-card');
                if (popup) {
                    popup.classList.add('active');
                }
            }
        }
    }

    const config = {
        id,
        pitch: Number(spot.pitch) || 0,
        yaw: Number(spot.yaw) || 0,
        type: 'info',
        cssClass: 'custom-hotspot-marker',
        createTooltipFunc: function (hotSpotDiv) {
            // 如果沒有文字，只回傳空結構；有文字則放入 span
            hotSpotDiv.innerHTML = label ? `<div class="custom-hotspot-inner">${label}</div>` : '<div class="custom-hotspot-inner"></div>';

            // 阻擋事件冒泡，防止 Pannellum 的背景視窗（Viewer）誤判為拖曳或調整視角
            const stopPropagation = (e) => {
                e.stopPropagation();
            };

            // 綁定所有可能觸發拖曳與視角調整的指標與觸控事件
            const events = [
                'mousedown', 'mousemove', 'mouseup', 'click',
                'touchstart', 'touchmove', 'touchend',
                'pointerdown', 'pointermove', 'pointerup'
            ];
            events.forEach(evt => {
                hotSpotDiv.addEventListener(evt, stopPropagation, { passive: true });
            });
            const inner = hotSpotDiv.querySelector('.custom-hotspot-inner');
            [hotSpotDiv, inner].filter(Boolean).forEach(el => {
                el.style.pointerEvents = 'auto';
                el.style.cursor = 'pointer';
                el.addEventListener('click', activateHotspot, true);
                el.addEventListener('pointerup', activateHotspot, true);
                el.addEventListener('touchend', activateHotspot, true);
            });
        },

        // 🆕 關鍵附加資料：供 getHotSpots() 及儲存提取使用
        hotspotType: spot.type || 'info',
        text: spot.text || '',
        image: spot.image || '',
        images: normalizeHotspotImages(spot),
        targetScene: spot.targetScene || ''
    };

    // 點擊事件 (整合浮動視窗 / 導覽切換場景)
    config.clickHandlerFunc = activateHotspot;

    return config;
}
function whenPanoReady(viewer, fn) {
    if (!viewer || typeof fn !== 'function') return;
    const run = () => {
        try {
            if (typeof viewer.isLoaded === 'function' && !viewer.isLoaded()) return;
        } catch (e) { return; }
        fn();
    };
    if (typeof viewer.on === 'function') viewer.on('load', run);
    [200, 600, 1200, 2500].forEach(ms => setTimeout(run, ms));
}

function focusHotspotInViewer(spot, animated = true, hfov = undefined) {
    if (!currentViewer || !spot) return;
    const pitch = Number(spot.pitch) || 0;
    const yaw = Number(spot.yaw) || 0;
    try {
        if (typeof currentViewer.lookAt === 'function') {
            currentViewer.lookAt(pitch, yaw, hfov, animated ? 700 : 0);
        } else {
            if (typeof currentViewer.setPitch === 'function') currentViewer.setPitch(pitch);
            if (typeof currentViewer.setYaw === 'function') currentViewer.setYaw(yaw);
            if (hfov !== undefined && typeof currentViewer.setHfov === 'function') currentViewer.setHfov(hfov);
        }
    } catch (e) { }
}

function previewHotspotPosition(index) {
    const spot = hotspotsEditorData[index];
    if (!spot) return;
    if (!currentViewer && currentEditing360File) {
        if (isHotspotAdminContext()) openInlineHotspotViewer(currentEditing360File);
        else openPanoramaMode(resolvePanoUrl(currentEditing360File), currentEditing360File);
        setTimeout(() => previewHotspotPosition(index), 900);
        return;
    }
    activeHotspotIndex = index;
    renderHotspotsList();
    focusHotspotInViewer(spot, true);
    showToast(`👁 預覽熱點 P:${spot.pitch}° Y:${spot.yaw}°`);
}
window.previewHotspotPosition = previewHotspotPosition;

function renderHotspotsInPannellum(viewer, hotspots) {
    if (!viewer || !hotspots || !hotspots.length) return;

    hotspots.forEach((spot, index) => {
        const id = spot.id || `hotspot-${index}`;
        try {
            if (typeof viewer.removeHotSpot === 'function') viewer.removeHotSpot(id);
        } catch (e) { }
    });

    hotspots.forEach((spot, index) => {
        try {
            viewer.addHotSpot(buildPannellumHotspotConfig(spot, index));
        } catch (e) {
            console.warn('addHotSpot failed:', spot.id, e);
        }
    });
    viewer.__tykHotspotIds = hotspots.map((spot, index) => spot.id || `hotspot-${index}`);
}

async function loadAndRenderHotspots(viewer, fileOrUrl) {
    if (!viewer) return [];
    const fileName = resolve360FileName(fileOrUrl);
    if (!fileName) return [];
    let hotspots;
    if (currentEditing360File === fileName && hotspotsEditorData.length) {
        hotspots = hotspotsEditorData;
    } else {
        hotspots = await loadHotspotsFor360Image(fileName);
    }
    renderHotspotsInPannellum(viewer, hotspots);
    return hotspots;
}

function scheduleHotspotRender(viewer, fileOrUrl) {
    whenPanoReady(viewer, () => loadAndRenderHotspots(viewer, fileOrUrl));
}

// ===== 熱點管理系統 v2（整合版）=====
let currentEditing360File = null;
let hotspotsEditorData = [];
let activeHotspotIndex = -1;

// 開啟熱點編輯器（整合到主面板）
async function openHotspotEditor(filename) {
    currentEditing360File = filename;
    hotspotsEditorData = await loadHotspotsFor360Image(filename);
    activeHotspotIndex = -1;

    // 顯示熱點管理面板
    const panel = document.getElementById('hotspotManagePanel');
    if (panel) {
        panel.style.display = 'block';
        renderHotspotsList();
        updateHotspotCount();
    }

    // 顯示熱點編輯器按鈕
    const btn = document.getElementById('btnOpenHotspotEditor');
    if (btn) btn.style.display = 'block';

    const hint = document.getElementById('hotspotEditorHint');
    if (hint) hint.style.display = 'block';

    const select = document.getElementById('hotspot360ImageSelect');
    if (select && filename) select.value = filename;

    if (document.getElementById('hotspot-pano-viewer')) {
        openInlineHotspotViewer(filename);
    }

    showToast(`✅ 已載入熱點：${filename}`);
}

// 關閉熱點編輯器
function closeHotspotEditor() {
    // 檢查是否有未儲存的熱點
    if (hotspotsEditorData.length > 0) {
        const confirmClose = confirm(`您有 ${hotspotsEditorData.length} 個熱點尚未儲存，確定要關閉嗎？\n\n點擊「確定」將遺失所有未儲存的熱點。`);
        if (!confirmClose) {
            return; // 使用者選擇保留，不關閉
        }
    }

    const panel = document.getElementById('hotspotManagePanel');
    if (panel) panel.style.display = 'none';

    const btn = document.getElementById('btnOpenHotspotEditor');
    if (btn) btn.style.display = 'none';

    const hint = document.getElementById('hotspotEditorHint');
    if (hint) hint.style.display = 'none';

    currentEditing360File = null;
    hotspotsEditorData = [];
    activeHotspotIndex = -1;
}

// 渲染熱點列表（整合版）
function renderHotspotsList() {
    const listEl = document.getElementById('hotspotsList');
    if (!listEl) return;

    if (!hotspotsEditorData.length) {
        listEl.innerHTML = '<div class="no-hotspots">尚無熱點，開啟 360 全景後點擊畫面即可新增</div>';
        return;
    }

    listEl.innerHTML = hotspotsEditorData.map((spot, index) => `
        <div class="hotspot-item ${index === activeHotspotIndex ? 'active' : ''}" onclick="selectHotspot(${index})">
            <div class="hotspot-info">
                <strong>
                    ${spot.type || 'info'}
                    <span class="hotspot-type-badge">${spot.type || 'info'}</span>
                </strong>
                <span>P: ${spot.pitch || 0}°, Y: ${spot.yaw || 0}°</span>
                ${spot.text ? `<span>${spot.text.substring(0, 40)}</span>` : ''}
            </div>
            <div class="hotspot-actions">
                <button onclick="event.stopPropagation(); previewHotspotPosition(${index})" class="hotspot-action-btn btn-preview">👁 預覽</button>
                <button onclick="event.stopPropagation(); editHotspot(${index})" class="hotspot-action-btn btn-edit">編輯</button>
                <button onclick="event.stopPropagation(); deleteHotspot(${index})" class="hotspot-action-btn btn-delete">刪除</button>
            </div>
        </div>
    `).join('');
}

// 選擇熱點
function selectHotspot(index) {
    previewHotspotPosition(index);
}

// 新增熱點
function addNewHotspot() {
    if (!currentEditing360File) {
        showToast('⚠️ 請先開啟 360 全景圖片');
        return;
    }

    // 如果當前沒有開啟 360 檢視器，自動開啟
    if (!currentViewer) {
        if (isHotspotAdminContext()) {
            openInlineHotspotViewer(currentEditing360File);
            setTimeout(() => { _actuallyAddHotspot(); }, 800);
            return;
        }
        const targetUrl = resolvePanoUrl(currentEditing360File);
        if (targetUrl) {
            try {
                // 開啟全景模式
                openPanoramaMode(targetUrl, currentEditing360File);
                // 等待檢視器載入
                setTimeout(() => {
                    _actuallyAddHotspot();
                }, 1000);
                return;
            } catch (e) {
                console.error('開啟 360 檢視器失敗:', e);
                showToast('❌ 無法開啟 360 檢視器');
                return;
            }
        }
    }

    _actuallyAddHotspot();
}

// 實際新增熱點的函數
function _actuallyAddHotspot() {
    // 取得當前視角（如果無法取得，使用預設值）
    let pitch = 0, yaw = 0;
    if (currentViewer) {
        try {
            if (typeof currentViewer.getPitch === 'function') {
                pitch = Math.round(currentViewer.getPitch() * 10) / 10;
            }
            if (typeof currentViewer.getYaw === 'function') {
                yaw = Math.round(currentViewer.getYaw() * 10) / 10;
            }
        } catch (e) {
            console.warn('無法取得當前視角，使用預設值', e);
        }
    }

    // 如果還是 0，給一個隨機但合理的初始值（避免全部都在同一位置）
    if (pitch === 0 && yaw === 0) {
        pitch = Math.round((Math.random() * 40 - 20) * 10) / 10; // -20 到 20 度
        yaw = Math.round((Math.random() * 360) * 10) / 10; // 0 到 360 度
    }

    // 檢查是否有重疊的點，若有則進行微調偏移，避免重疊
    let offsetCount = 0;
    while (hotspotsEditorData.some(h => Math.abs((h.pitch || 0) - pitch) < 0.5 && Math.abs((h.yaw || 0) - yaw) < 0.5) && offsetCount < 10) {
        pitch += Math.round((Math.random() * 6 - 3) * 10) / 10;
        yaw += Math.round((Math.random() * 10 - 5) * 10) / 10;
        pitch = Math.max(-85, Math.min(85, pitch));
        yaw = (yaw + 360) % 360;
        offsetCount++;
    }

    const newSpot = {
        id: `hotspot-${Date.now()}`,
        pitch: pitch,
        yaw: yaw,
        type: 'info',
        text: '',
        title: '',
        content: '',
        image: '',
        images: [],
        targetScene: ''
    };

    hotspotsEditorData.push(newSpot);
    activeHotspotIndex = hotspotsEditorData.length - 1;
    renderHotspotsList();
    updateHotspotCount();

    // 顯示熱點詳細設定面板
    const settingsPanel = document.getElementById('hotspotSettingsPanel');
    if (settingsPanel) {
        settingsPanel.style.display = 'block';
    }

    // 延遲填入表單，確保 DOM 已經更新
    setTimeout(() => {
        editHotspot(activeHotspotIndex);
    }, 100);

    // 在 Pannellum 中顯示新熱點
    if (currentViewer && typeof currentViewer.addHotSpot === 'function') {
        try {
            currentViewer.addHotSpot(buildPannellumHotspotConfig(newSpot, hotspotsEditorData.length - 1));

            // 視覺回饋：在 360 畫面上顯示標記動畫
            const flash = document.createElement('div');
            flash.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(16,172,132,0.95);color:#fff;padding:18px 32px;border-radius:16px;font-size:18px;font-weight:700;z-index:100000;pointer-events:none;animation:fadeOut 1s ease forwards;box-shadow:0 10px 40px rgba(16,172,132,0.5);';
            flash.textContent = `📍 已在 360 畫面標記 (P:${pitch}°, Y:${yaw}°)`;
            document.body.appendChild(flash);
            setTimeout(() => flash.remove(), 1200);
        } catch (e) {
            console.error('在 Pannellum 中顯示熱點失敗:', e);
        }
    }

    showToast(`✅ 已新增熱點並標記在 360 畫面上 (P:${pitch}°, Y:${yaw}°)`);
    setTimeout(() => previewHotspotPosition(activeHotspotIndex), 300);
}

function syncHotspotFromForm(preview = false) {
    if (activeHotspotIndex < 0) return;
    const spot = hotspotsEditorData[activeHotspotIndex];
    if (!spot) return;
    const pitchVal = parseFloat(document.getElementById('hotspotPitch')?.value);
    const yawVal = parseFloat(document.getElementById('hotspotYaw')?.value);
    if (Number.isFinite(pitchVal)) spot.pitch = pitchVal;
    if (Number.isFinite(yawVal)) spot.yaw = yawVal;
    // 其他屬性同步
    const typeEl = document.getElementById('hotspotType');
    const textEl = document.getElementById('hotspotText');
    const titleEl = document.getElementById('hotspotTitle');
    const contentEl = document.getElementById('hotspotContent');
    const imageEl = document.getElementById('hotspotImageSelect');
    const sceneEl = document.getElementById('hotspotScene');
    if (typeEl) spot.type = typeEl.value;
    if (textEl) spot.text = textEl.value;
    if (titleEl) spot.title = titleEl.value;
    if (contentEl) spot.content = contentEl.value;
    if (imageEl) {
        const selectedImages = Array.from(imageEl.selectedOptions || []).map(opt => opt.value).filter(Boolean);
        spot.images = selectedImages;
        spot.image = selectedImages.join(',');
    }
    if (sceneEl) spot.targetScene = sceneEl.value;
    // 更新 Pannellum
    if (currentViewer && spot.id) {
        try { currentViewer.removeHotSpot(spot.id); } catch (e) { }
        try { currentViewer.addHotSpot(buildPannellumHotspotConfig(spot, activeHotspotIndex)); } catch (e) { }
    }
    renderHotspotsList();
    if (preview) focusHotspotInViewer(spot, true);
}

// 編輯熱點
function editHotspot(index) {
    const spot = hotspotsEditorData[index];
    if (!spot) return;

    activeHotspotIndex = index;

    // 顯示熱點詳細設定面板
    const settingsPanel = document.getElementById('hotspotSettingsPanel');
    if (settingsPanel) {
        settingsPanel.style.display = 'block';
    }

    // 安全地設置表單值
    const hotspotIdEl = document.getElementById('hotspotId');
    const hotspotPitchEl = document.getElementById('hotspotPitch');
    const hotspotYawEl = document.getElementById('hotspotYaw');
    const hotspotTypeEl = document.getElementById('hotspotType');
    const hotspotTextEl = document.getElementById('hotspotText');
    const hotspotTitleEl = document.getElementById('hotspotTitle');
    const hotspotContentEl = document.getElementById('hotspotContent');
    const hotspotImageEl = document.getElementById('hotspotImageSelect');
    const hotspotSceneEl = document.getElementById('hotspotScene');

    if (hotspotIdEl) hotspotIdEl.value = spot.id || '';
    if (hotspotPitchEl) hotspotPitchEl.value = spot.pitch || 0;
    if (hotspotYawEl) hotspotYawEl.value = spot.yaw || 0;
    if (hotspotTypeEl) hotspotTypeEl.value = spot.type || 'info';
    if (hotspotTextEl) hotspotTextEl.value = spot.text || '';
    if (hotspotTitleEl) hotspotTitleEl.value = spot.title || '';
    if (hotspotContentEl) hotspotContentEl.value = spot.content || '';
    if (hotspotImageEl) {
        const selectedFiles = new Set(normalizeHotspotImages(spot).map(v => getImageFileName(v)));
        Array.from(hotspotImageEl.options).forEach(opt => {
            opt.selected = selectedFiles.has(getImageFileName(opt.value));
        });
    }
    if (hotspotSceneEl) hotspotSceneEl.value = spot.targetScene || '';
    // 更新欄位可見性（根據類型顯示圖片或場景欄位）
    if (typeof updateHotspotFormVisibility === 'function') updateHotspotFormVisibility();
    if (typeof loadHotspotImageList === 'function') {
        loadHotspotImageList().then(() => {
            const sceneEl = document.getElementById('hotspotScene');
            if (sceneEl) sceneEl.value = spot.targetScene || '';
        }).catch(() => { });
    }

    renderHotspotsList();
    focusHotspotInViewer(spot, true);
    showToast('📝 已載入熱點資料，請在下方編輯');
}

// 刪除熱點
function deleteHotspot(index) {
    if (!confirm('確定要刪除此熱點嗎？')) return;

    const spot = hotspotsEditorData[index];
    hotspotsEditorData.splice(index, 1);

    // 從 Pannellum 中移除
    if (currentViewer && spot && typeof currentViewer.removeHotSpot === 'function') {
        try {
            currentViewer.removeHotSpot(spot.id);
        } catch (e) { }
    }

    if (activeHotspotIndex === index) {
        activeHotspotIndex = -1;
    } else if (activeHotspotIndex > index) {
        activeHotspotIndex--;
    }

    renderHotspotsList();
    updateHotspotCount();
    showToast('🗑️ 已刪除熱點');
}

// 儲存熱點
async function saveHotspots() {
    console.log('========================================');
    console.log('💾 儲存熱點函數被呼叫');
    console.log('   時間:', new Date().toLocaleTimeString());
    console.log('========================================');

    // 🆕 關鍵修正：直接從 Pannellum viewer 提取熱點
    let hotspotData = [];

    // 先同步當前表單到 hotspotsEditorData（確保最新編輯被收入）
    syncHotspotFromForm(false);

    if (currentViewer && typeof currentViewer.getHotSpots === 'function') {
        try {
            // Pannellum 3.x/4.x 使用 getHotSpots() 方法
            const pannellumHotspots = currentViewer.getHotSpots();
            console.log('   從 Pannellum 提取到', pannellumHotspots.length, '個熱點');

            // 轉換時合併 hotspotsEditorData，保留 title/content/targetScene 等 Pannellum 不儲存的欄位
            hotspotData = pannellumHotspots.map(spot => {
                const editorSpot = hotspotsEditorData.find(e => e.id === spot.id) || {};
                return {
                    id: spot.id || `hotspot-${Date.now()}-${Math.random()}`,
                    pitch: spot.pitch || 0,
                    yaw: spot.yaw || 0,
                    type: editorSpot.type || spot.type || 'info',
                    text: editorSpot.text !== undefined ? editorSpot.text : (spot.text || ''),
                    title: editorSpot.title || '',
                    content: editorSpot.content || '',
                    image: editorSpot.image !== undefined ? editorSpot.image : (spot.image || ''),
                    images: normalizeHotspotImages({ ...spot, ...editorSpot }),
                    targetScene: editorSpot.targetScene || '',
                    imageYaw: spot.imageYaw,
                    imagePitch: spot.imagePitch,
                    cssClass: spot.cssClass || 'custom-hotspot-marker'
                };
            });

            // 若 Pannellum 沒有記錄的熱點（純在 editor 中），也納入
            hotspotsEditorData.forEach(editorSpot => {
                if (!hotspotData.find(h => h.id === editorSpot.id)) {
                    hotspotData.push({ ...editorSpot });
                }
            });

            console.log('   合併後的熱點資料:', JSON.stringify(hotspotData, null, 2));
        } catch (e) {
            console.error('   從 Pannellum 提取熱點失敗:', e);
            // 降級：使用內部的 hotspotsEditorData
            hotspotData = [...hotspotsEditorData];
        }
    } else {
        console.warn('   ⚠️ 無法從 Pannellum 提取熱點，使用內部陣列');
        hotspotData = [...hotspotsEditorData];
    }

    // 立即保存檔案名稱（防止後續被重置）
    let editingFile = currentEditing360File;

    // 如果為空，嘗試從 localStorage 恢復
    if (!editingFile) {
        console.log('   ⚠️ currentEditing360File 為空！');
        console.log('   嘗試從 localStorage 恢復...');
        const savedFile = localStorage.getItem('currentEditing360File');
        console.log('   localStorage 中的值:', savedFile);

        if (savedFile) {
            currentEditing360File = savedFile;
            editingFile = savedFile;
            console.log('   ✅ 已從 localStorage 恢復:', savedFile);
        } else {
            console.log('   ❌ localStorage 中也沒有值！');
            showToast('⚠️ 沒有可儲存的熱點，請先選擇 360 全景圖片');
            return;
        }
    }

    // 再次檢查
    const finalEditingFile = editingFile;
    if (!finalEditingFile) {
        showToast('⚠️ 沒有可儲存的熱點，請先選擇 360 全景圖片');
        return;
    }

    console.log('💾 開始儲存熱點:', finalEditingFile);
    console.log('=== 準備發送到後端的資料 ===');
    console.log('熱點陣列:', JSON.stringify(hotspotData, null, 2));
    console.log('熱點數量:', hotspotData.length);

    // 如果收到空陣列，記錄警告
    if (hotspotData.length === 0) {
        console.warn('   ⚠️ 警告：熱點陣列為空！');
    }

    try {
        const url = `${API_BASE}/api/hotspots/${encodeURIComponent(editingFile)}`;
        console.log('發送請求到:', url);

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hotspotData)
        });

        console.log('回應狀態:', res.status, res.statusText);
        console.log('回應 OK:', res.ok);

        if (res.ok) {
            const result = await res.json();
            console.log('儲存成功:', result);
            showToast('✅ 熱點已儲存');

            // 更新內部的 hotspotsEditorData
            hotspotsEditorData = hotspotData;

            // 恢復 currentEditing360File（可能被重置）
            currentEditing360File = editingFile;

            // 等待一下讓後端完成寫入
            await new Promise(resolve => setTimeout(resolve, 300));

            // 重新載入熱點（從後端驗證）
            console.log('重新載入熱點驗證:', editingFile);
            hotspotsEditorData = await loadHotspotsFor360Image(editingFile);
            console.log('重新載入後熱點數量:', hotspotsEditorData.length);
            renderHotspotsList();
            updateHotspotCount();

            // 重新載入 360 檢視器與最新熱點
            if (isHotspotAdminContext()) {
                openInlineHotspotViewer(editingFile);
            } else if (currentViewer) {
                currentViewer.destroy();
                currentViewer = null;
                const targetUrl = resolvePanoUrl(editingFile);
                if (targetUrl) {
                    try {
                        currentViewer = pannellum.viewer('panorama-viewer', {
                            type: 'equirectangular',
                            panorama: targetUrl,
                            autoLoad: true,
                            compass: false,
                            showControls: true,
                            hfov: 60
                        });
                        scheduleHotspotRender(currentViewer, editingFile);
                    } catch (e) {
                        console.error('重新載入全景檢視器失敗:', e);
                    }
                }
            } else {
                scheduleHotspotRender(currentViewer, editingFile);
            }

            if (activeHotspotIndex >= 0) {
                setTimeout(() => previewHotspotPosition(activeHotspotIndex), 800);
            }

            // 確保 currentEditing360File 仍然被設置
            currentEditing360File = editingFile;
            console.log('儲存完成後，currentEditing360File:', currentEditing360File);
        } else {
            const errorText = await res.text();
            console.error('儲存失敗:', res.status, errorText);
            showToast(`❌ 儲存失敗 (${res.status})`);
        }
    } catch (err) {
        console.error('儲存熱點失敗:', err);
        showToast(`❌ 儲存熱點失敗: ${err.message}`);
    }
}

// 更新熱點數量
function updateHotspotCount() {
    const countEl = document.getElementById('hotspotCount');
    if (countEl) {
        countEl.textContent = `${hotspotsEditorData.length} 個熱點`;
    }
}

// 綁定熱點編輯器按鈕
document.addEventListener('DOMContentLoaded', function () {
    const btnOpenHotspotEditor = document.getElementById('btnOpenHotspotEditor');
    const btnAddHotspot = document.getElementById('btnAddHotspot');
    const btnSaveHotspot = document.getElementById('btnSaveHotspot'); // 修復：使用正確的 ID（單數）
    const btnCloseHotspotEditor = document.getElementById('btnCloseHotspotEditor');
    const btnEnterPinningMode = document.getElementById('btnEnterPinningMode');
    const pinningModeSection = document.getElementById('pinningModeSection');

    if (btnOpenHotspotEditor) {
        btnOpenHotspotEditor.addEventListener('click', () => {
            const current360File = getImageFileName(currentPanoramaPointId || '');
            if (current360File) {
                openHotspotEditor(current360File);
            } else {
                showToast('⚠️ 請先開啟一個 360 全景圖片');
            }
        });
    }

    if (btnAddHotspot) {
        btnAddHotspot.addEventListener('click', addNewHotspot);
    }

    if (btnSaveHotspot) { // 修復：使用正確的變數名
        btnSaveHotspot.addEventListener('click', saveHotspots);
    }

    const btnPreviewHotspot = document.getElementById('btnPreviewHotspot');
    if (btnPreviewHotspot) {
        btnPreviewHotspot.addEventListener('click', () => {
            syncHotspotFromForm(true);
            if (activeHotspotIndex >= 0) previewHotspotPosition(activeHotspotIndex);
        });
    }

    const hotspotPitchInput = document.getElementById('hotspotPitch');
    const hotspotYawInput = document.getElementById('hotspotYaw');
    const hotspotTypeInput = document.getElementById('hotspotType');
    [hotspotPitchInput, hotspotYawInput].forEach(input => {
        if (!input) return;
        input.addEventListener('change', () => syncHotspotFromForm(true));
    });
    if (hotspotTypeInput) {
        hotspotTypeInput.addEventListener('change', () => {
            updateHotspotFormVisibility();
            loadHotspotImageList();
            syncHotspotFromForm(true);
        });
    }

    if (btnCloseHotspotEditor) {
        btnCloseHotspotEditor.addEventListener('click', closeHotspotEditor);
    }

    // 🆕 綁定「進入標記模式」按鈕
    if (btnEnterPinningMode) {
        btnEnterPinningMode.addEventListener('click', () => {
            if (!currentViewer) {
                showToast('⚠️ 請先開啟 360 全景圖片');
                return;
            }
            enterPinningMode();
        });
    }

    // 鍵盤快捷鍵
    document.addEventListener('keydown', (e) => {
        // Space 鍵切換熱點顯示/隱藏（全域）
        if (e.code === 'Space' && currentViewer && isAdminMode) {
            e.preventDefault();
            toggleHotspotsVisibility();
        }

        if (!currentEditing360File && !isPinningMode) return;

        // Delete 鍵刪除熱點
        if (e.key === 'Delete' && activeHotspotIndex >= 0 && !isPinningMode) {
            deleteHotspot(activeHotspotIndex);
        }

        // Escape 鍵關閉
        if (e.key === 'Escape') {
            if (isPinningMode) {
                exitPinningMode();
            } else if (currentEditing360File) {
                closeHotspotEditor();
            }
        }

        // Ctrl+S 儲存
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            if (isPinningMode) {
                confirmHotspotPlacement();
            } else if (currentEditing360File) {
                saveHotspots();
            }
        }
    });

    // 監聽 360 模式開啟，顯示標記模式按鈕
    const originalOpenPanoramaMode = window.openPanoramaMode;
    window.openPanoramaMode = function (imageUrl, currentPointId = null) {
        // 呼叫原本的函數
        originalOpenPanoramaMode(imageUrl, currentPointId);

        // 顯示標記模式按鈕（管理員模式）
        if (pinningModeSection && isAdminMode) {
            setTimeout(() => {
                pinningModeSection.style.display = 'block';
            }, 1000);
        }
    };

    // 監聽 360 模式關閉，隱藏標記模式按鈕
    const originalClosePanoramaMode = window.closePanoramaMode;
    window.closePanoramaMode = function () {
        // 離開標記模式
        if (isPinningMode) {
            exitPinningMode();
        }

        // 隱藏標記模式按鈕
        if (pinningModeSection) {
            pinningModeSection.style.display = 'none';
        }

        // 關閉熱點編輯器
        closeHotspotEditor();

        // 呼叫原本的函數
        originalClosePanoramaMode();
    };
});

// ===== Google Maps 式熱點標註模式功能 =====

// 進入標記模式
function enterPinningMode() {
    if (!currentViewer || !isAdminMode) return;

    isPinningMode = true;
    pendingHotspotPosition = null;

    // 顯示十字瞄準線
    showCrosshair(true);

    // 顯示懸浮標記
    showFloatingPin(true);

    // 顯示標記模式控制列
    showPinModeControls(true);

    // 顯示標記模式指示器
    showPinModeIndicator(true);

    // 鎖定 Pannellum 視角（防止拖曳）
    lockPannellumView(true);

    showToast('🎯 已進入標記模式，調整視角後點擊「確認位置」');
}

// 離開標記模式
function exitPinningMode() {
    isPinningMode = false;
    pendingHotspotPosition = null;

    // 隱藏 UI 元素
    showCrosshair(false);
    showFloatingPin(false);
    showPinModeControls(false);
    showPinModeIndicator(false);

    // 解鎖 Pannellum 視角
    lockPannellumView(false);

    // 移除懸浮標記元素
    if (floatingPinElement && floatingPinElement.parentNode) {
        floatingPinElement.parentNode.removeChild(floatingPinElement);
        floatingPinElement = null;
    }
}

// 顯示/隱藏十字瞄準線
function showCrosshair(show) {
    let crosshair = document.getElementById('panorama-crosshair');
    if (!crosshair) {
        crosshair = document.createElement('div');
        crosshair.id = 'panorama-crosshair';
        crosshair.className = 'panorama-crosshair';
        crosshair.innerHTML = '<div class="panorama-crosshair-circle"></div>';
        document.getElementById('panorama-overlay')?.appendChild(crosshair);
    }

    if (show) {
        crosshair.classList.add('active');
    } else {
        crosshair.classList.remove('active');
    }
}

// 顯示/隱藏懸浮標記
function showFloatingPin(show) {
    if (!floatingPinElement) {
        floatingPinElement = document.createElement('div');
        floatingPinElement.className = 'floating-hotspot-preview';
        document.getElementById('panorama-overlay')?.appendChild(floatingPinElement);
    }

    if (show) {
        floatingPinElement.classList.add('active');
        updateFloatingPinPosition();
    } else {
        floatingPinElement.classList.remove('active');
    }
}

// 更新懸浮標記位置（跟隨視角）
function updateFloatingPinPosition() {
    if (!currentViewer || !floatingPinElement) return;

    try {
        const pitch = currentViewer.getPitch();
        const yaw = currentViewer.getYaw();

        // 更新懸浮標記的座標顯示
        if (floatingPinElement) {
            floatingPinElement.setAttribute('data-pitch', pitch.toFixed(1));
            floatingPinElement.setAttribute('data-yaw', yaw.toFixed(1));
        }
    } catch (e) { }
}

// 顯示/隱藏標記模式控制列
function showPinModeControls(show) {
    let controls = document.getElementById('pin-mode-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'pin-mode-controls';
        controls.className = 'pin-mode-controls';
        controls.innerHTML = `
            <button class="pin-mode-btn confirm" onclick="confirmHotspotPlacement()">✓ 確認位置</button>
            <button class="pin-mode-btn cancel" onclick="exitPinningMode()">✕ 取消</button>
        `;
        document.getElementById('panorama-overlay')?.appendChild(controls);
    }

    if (show) {
        controls.classList.add('active');
    } else {
        controls.classList.remove('active');
    }
}

// 顯示/隱藏標記模式指示器
function showPinModeIndicator(show) {
    let indicator = document.getElementById('pin-mode-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'pin-mode-indicator';
        indicator.className = 'pin-mode-indicator';
        indicator.textContent = '標記模式 - 調整視角後確認位置';
        document.getElementById('panorama-overlay')?.appendChild(indicator);
    }

    if (show) {
        indicator.classList.add('active');
    } else {
        indicator.classList.remove('active');
    }
}

// 鎖定/解鎖 Pannellum 視角
function lockPannellumView(lock) {
    if (!currentViewer) return;

    try {
        if (lock) {
            // 儲存當前視角
            pendingHotspotPosition = {
                pitch: currentViewer.getPitch(),
                yaw: currentViewer.getYaw()
            };

            // 禁用拖曳
            currentViewer.setLock(true);
        } else {
            // 解鎖
            currentViewer.setLock(false);
            pendingHotspotPosition = null;
        }
    } catch (e) {
        console.warn('Pannellum lock/unlock failed:', e);
    }
}

// 確認熱點位置
function confirmHotspotPlacement() {
    if (!currentViewer || !isPinningMode) return;

    // 取得當前視角
    let pitch, yaw;
    try {
        pitch = currentViewer.getPitch();
        yaw = currentViewer.getYaw();
    } catch (e) {
        showToast('❌ 無法取得視角資訊');
        return;
    }

    // 儲存位置
    pendingHotspotPosition = { pitch, yaw };

    // 離開標記模式
    exitPinningMode();

    // 顯示 Info Box 讓管理員輸入熱點資訊
    showHotspotInfoBox(null, pitch, yaw);
}

// 顯示熱點 Info Box（彈出式表單）
function showHotspotInfoBox(existingHotspot = null, pitch = 0, yaw = 0) {
    // 移除舊的 Info Box
    const existingBox = document.getElementById('hotspot-info-box');
    if (existingBox) existingBox.remove();

    const isEditing = existingHotspot !== null;
    const box = document.createElement('div');
    box.id = 'hotspot-info-box';
    box.className = 'hotspot-info-box';

    // 計算位置（在畫面中央偏右）
    const overlay = document.getElementById('panorama-overlay');
    const overlayRect = overlay.getBoundingClientRect();
    const boxWidth = 300;
    const boxHeight = 400;

    let left = (overlayRect.width - boxWidth) / 2 + 100;
    let top = (overlayRect.height - boxHeight) / 2;

    // 確保不超出邊界
    left = Math.max(20, Math.min(left, overlayRect.width - boxWidth - 20));
    top = Math.max(20, Math.min(top, overlayRect.height - boxHeight - 20));

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;

    box.innerHTML = `
        <div class="hotspot-info-box-header">
            <div class="hotspot-info-box-title">
                <span>📍</span>
                <span>${isEditing ? '編輯熱點' : '新增熱點'}</span>
            </div>
            <button class="hotspot-info-box-close" onclick="closeHotspotInfoBox()">×</button>
        </div>
        <div class="hotspot-info-box-content">
            <input type="text" id="infoBox-hotspotId" value="${existingHotspot?.id || `hotspot-${Date.now()}`}" readonly style="display:none;">
            <input type="text" id="infoBox-hotspotText" placeholder="熱點文字（選填）" value="${existingHotspot?.text || ''}" />
            <select id="infoBox-hotspotType">
                <option value="info" ${existingHotspot?.type === 'info' ? 'selected' : ''}>資訊</option>
                <option value="scene" ${existingHotspot?.type === 'scene' ? 'selected' : ''}>場景</option>
                <option value="link" ${existingHotspot?.type === 'link' ? 'selected' : ''}>連結</option>
            </select>

            <input type="text" id="infoBox-hotspotImage" placeholder="圖片 URL（選填）" value="${existingHotspot?.image || ''}" />
            <div style="font-size:11px;color:#64748b;font-weight:600;font-family:monospace;">
                P: ${pitch.toFixed(1)}°, Y: ${yaw.toFixed(1)}°
            </div>
        </div>
        <div class="hotspot-info-box-actions">
            <button class="btn-cancel" onclick="closeHotspotInfoBox()">取消</button>
            <button class="btn-delete" onclick="deletePendingHotspot()" style="display:${isEditing ? 'block' : 'none'}">刪除</button>
            <button class="btn-save" onclick="saveHotspotFromInfoBox(${isEditing})">儲存</button>
        </div>
    `;

    overlay.appendChild(box);

    // 動畫顯示
    requestAnimationFrame(() => {
        box.classList.add('active');
    });

    // 聚焦到文字輸入框
    setTimeout(() => {
        const textInput = document.getElementById('infoBox-hotspotText');
        if (textInput) textInput.focus();
    }, 300);
}

// 關閉熱點 Info Box
function closeHotspotInfoBox() {
    const box = document.getElementById('hotspot-info-box');
    if (box) {
        box.classList.remove('active');
        setTimeout(() => box.remove(), 300);
    }

    // 如果沒有確認位置，清除 pending
    if (!pendingHotspotPosition) {
        // 重新進入標記模式
        if (isAdminMode && currentViewer) {
            setTimeout(() => enterPinningMode(), 300);
        }
    }
}

// 從 Info Box 儲存熱點
function saveHotspotFromInfoBox(isEditing = false) {
    if (!pendingHotspotPosition) return;

    const text = document.getElementById('infoBox-hotspotText')?.value || '';
    const type = document.getElementById('infoBox-hotspotType')?.value || 'info';
    const image = document.getElementById('infoBox-hotspotImage')?.value || '';
    const images = normalizeHotspotImages({ image });
    const hotspotId = document.getElementById('infoBox-hotspotId')?.value || `hotspot-${Date.now()}`;


    if (isEditing) {
        // 編輯現有熱點
        const index = hotspotsEditorData.findIndex(h => h.id === hotspotId);
        if (index >= 0) {
            hotspotsEditorData[index] = {
                ...hotspotsEditorData[index],
                text,
                type,
                image,
                images,
                pitch: pendingHotspotPosition.pitch,
                yaw: pendingHotspotPosition.yaw
            };
        }
    } else {
        // 新增熱點
        const newHotspot = {
            id: hotspotId,
            pitch: pendingHotspotPosition.pitch,
            yaw: pendingHotspotPosition.yaw,
            type,
            text,
            image,
            images
        };

        hotspotsEditorData.push(newHotspot);

        // 在 Pannellum 中顯示
        if (currentViewer && typeof currentViewer.addHotSpot === 'function') {
            try {
                currentViewer.addHotSpot(buildPannellumHotspotConfig(newHotspot, hotspotsEditorData.length - 1));
            } catch (e) { }
        }
    }

    // 關閉 Info Box
    closeHotspotInfoBox();

    // 更新熱點列表
    renderHotspotsList();
    updateHotspotCount();

    // 顯示成功訊息
    showToast(`✅ 熱點已${isEditing ? '更新' : '新增'}`);

    // 清除 pending
    pendingHotspotPosition = null;
}

// 刪除待確認的熱點
function deletePendingHotspot() {
    const hotspotId = document.getElementById('infoBox-hotspotId')?.value;
    if (!hotspotId) return;

    if (!confirm('確定要刪除此熱點嗎？')) return;

    // 從陣列中移除
    const index = hotspotsEditorData.findIndex(h => h.id === hotspotId);
    if (index >= 0) {
        hotspotsEditorData.splice(index, 1);

        // 從 Pannellum 中移除
        if (currentViewer && typeof currentViewer.removeHotSpot === 'function') {
            try {
                currentViewer.removeHotSpot(hotspotId);
            } catch (e) { }
        }
    }

    // 關閉 Info Box
    closeHotspotInfoBox();

    // 更新熱點列表
    renderHotspotsList();
    updateHotspotCount();

    showToast('🗑️ 熱點已刪除');
}

// Space 鍵切換熱點顯示/隱藏
let hotspotsVisible = true;
function toggleHotspotsVisibility() {
    if (!currentViewer) return;

    hotspotsVisible = !hotspotsVisible;

    try {
        if (hotspotsVisible) {
            const key = resolve360FileName(currentEditing360File || currentPanoramaPointId || '');
            loadAndRenderHotspots(currentViewer, key);
            showToast('👁️ 熱點已顯示');
        } else {
            (currentViewer.__tykHotspotIds || []).forEach(id => {
                try { currentViewer.removeHotSpot(id); } catch (e) { }
            });
            showToast('🙈 熱點已隱藏');
        }
    } catch (e) {
        console.warn('Toggle hotspots failed:', e);
    }
}

// 載入 360 圖片的

function isHotspotAdminContext() {
    return currentAdminSection === 'hotspot' && !!document.getElementById('hotspot-pano-viewer');
}

function setHotspotPanoPanelVisible(visible) {
    const panel = document.getElementById('hotspotPanoPanel');
    const mapSection = document.querySelector('.map-section');
    const mapWrapper = document.getElementById('map-wrapper');
    const layerBtn = document.getElementById('btnToggleLayer');
    if (panel) panel.style.display = visible ? 'flex' : 'none';
    if (mapSection) mapSection.classList.toggle('hotspot-mode-active', visible);
    if (mapWrapper && !visible) mapWrapper.style.display = '';
    if (layerBtn) layerBtn.style.display = visible ? 'none' : '';
}

function closeInlineHotspotViewer() {
    setHotspotPanoPanelVisible(false);
    const viewerContainer = document.getElementById('hotspot-pano-viewer');
    if (viewerContainer) {
        viewerContainer.removeEventListener('click', window.__panoClickHandler);
    }
    if (currentViewer) {
        currentViewer.destroy();
        currentViewer = null;
    }
}

function bindHotspotViewerClick(containerId, filename) {
    const viewerContainer = document.getElementById(containerId);
    if (!viewerContainer) return;

    viewerContainer.removeEventListener('click', window.__panoClickHandler);
    window.__panoClickHandler = function (e) {
        if (!isAdminMode || !currentViewer) return;
        if (e.target.closest('.pnlm-controls') || e.target.closest('.pnlm-ui')) return;

        let pitch = 0, yaw = 0;
        if (typeof currentViewer.getPitch === 'function') pitch = Math.round(currentViewer.getPitch() * 10) / 10;
        if (typeof currentViewer.getYaw === 'function') yaw = Math.round(currentViewer.getYaw() * 10) / 10;

        const fileName = filename || getImageFileName(currentEditing360File || '');
        if (!fileName) return;

        if (!currentEditing360File) openHotspotEditor(fileName);

        setTimeout(() => {
            addNewHotspot();
            const pitchInput = document.getElementById('hotspotPitch');
            const yawInput = document.getElementById('hotspotYaw');
            if (pitchInput) pitchInput.value = pitch;
            if (yawInput) yawInput.value = yaw;
            if (activeHotspotIndex >= 0 && hotspotsEditorData[activeHotspotIndex]) {
                hotspotsEditorData[activeHotspotIndex].pitch = pitch;
                hotspotsEditorData[activeHotspotIndex].yaw = yaw;
            }
        }, 150);
    };

    viewerContainer.addEventListener('click', window.__panoClickHandler);
    viewerContainer.style.cursor = isAdminMode ? 'crosshair' : 'default';
}

function openInlineHotspotViewer(filename) {
    const containerId = 'hotspot-pano-viewer';
    const targetUrl = resolvePanoUrl(filename);
    if (!targetUrl || !document.getElementById(containerId)) return;

    setHotspotPanoPanelVisible(true);

    const titleEl = document.getElementById('hotspotPanoTitle');
    if (titleEl) titleEl.textContent = filename;

    if (currentViewer) {
        currentViewer.destroy();
        currentViewer = null;
    }

    try {
        currentViewer = pannellum.viewer(containerId, {
            type: 'equirectangular',
            panorama: targetUrl,
            autoLoad: true,
            compass: false,
            showControls: true,
            hfov: 60
        });
        scheduleHotspotRender(currentViewer, filename);
        bindHotspotViewerClick(containerId, filename);
    } catch (err) {
        console.error('內嵌 360 檢視器建立失敗:', err);
        showToast('❌ 無法載入 360 全景');
    }
}

function openPanoramaMode(imageUrl, currentPointId = null) {
    const targetUrl = resolvePanoUrl(imageUrl);
    if (!targetUrl) {
        hidePanoramaLoadingOverlay();
        return;
    }

    const hotspotFile = resolve360FileName(imageUrl) || resolve360FileName(currentPointId) || getImageFileName(targetUrl);

    // 管理員熱點模式：左側內嵌 360，右側設定（不滿版）
    if (isHotspotAdminContext()) {
        currentPanoramaPointId = currentPointId || hotspotFile;
        currentEditing360File = hotspotFile;
        openInlineHotspotViewer(hotspotFile);
        return;
    }

    const overlay = document.getElementById('panorama-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    currentPanoramaPointId = currentPointId || hotspotFile;
    ensurePanoramaLoadingOverlay();
    if (currentViewer) {
        currentViewer.destroy();
        currentViewer = null;
    }
    try {
        currentViewer = pannellum.viewer('panorama-viewer', {
            type: 'equirectangular',
            panorama: targetUrl,
            autoLoad: true,
            compass: false,
            showControls: true,
            hfov: 60
        });
        if (typeof currentViewer.on === 'function') {
            currentViewer.on('load', () => {
                hidePanoramaLoadingOverlay();
                loadAndRenderHotspots(currentViewer, hotspotFile);
            });
        }
        scheduleHotspotRender(currentViewer, hotspotFile);
        panoramaLoadingTimer = setTimeout(hidePanoramaLoadingOverlay, 900);
    } catch (err) {
        console.error('全景檢視器建立失敗:', err);
        hidePanoramaLoadingOverlay();
    }
    renderPanoramaMiniMap(currentPanoramaPointId);
    initPanoramaMiniMapDrag();
    setTimeout(() => {
        initPanoramaMiniMapZoomResize();
    }, 100);

    // 🆕【管理員模式】在 360 全景圖片上直接點擊標點（熱點）
    // 在 openPanoramaMode 完成後，如果管理員模式且當前全景檔名已知，自動啟用點擊標點
    setTimeout(() => {
        const viewerContainer = document.getElementById('panorama-viewer');
        if (!viewerContainer) return;

        // 清除舊的點擊監聽避免重複綁定
        viewerContainer.removeEventListener('click', window.__panoClickHandler);

        window.__panoClickHandler = function (e) {
            // 只有管理員模式且已有開啟的 360 圖片才生效（不需要先開熱點編輯器）
            if (!isAdminMode) return;
            if (!currentViewer) return;

            let pitch = 0, yaw = 0;
            if (typeof currentViewer.getPitch === 'function') pitch = Math.round(currentViewer.getPitch() * 10) / 10;
            if (typeof currentViewer.getYaw === 'function') yaw = Math.round(currentViewer.getYaw() * 10) / 10;

            // 取得當前 360 圖片檔名
            const fileName = getImageFileName(currentPanoramaPointId || '');
            if (!fileName) return;

            // 自動打開熱點編輯器（如果尚未打開）
            const hotspotModal = document.getElementById('hotspotEditorModal');
            if (!hotspotModal || hotspotModal.style.display !== 'flex') {
                openHotspotEditor(fileName);
            }

            // 延遲一小段等熱點編輯器打開後再填入 / 新增
            setTimeout(() => {
                // 先新增一個熱點
                addNewHotspot();
                // 再填入目前視角的 pitch/yaw
                const pitchInput = document.getElementById('hotspotPitch');
                const yawInput = document.getElementById('hotspotYaw');
                if (pitchInput) pitchInput.value = pitch;
                if (yawInput) yawInput.value = yaw;

                // 🆕 立即在 Pannellum 檢視器上顯示這個新熱點
                if (currentViewer && typeof currentViewer.addHotSpot === 'function') {
                    try {
                        const tempSpot = { id: `hotspot-${Date.now()}`, pitch, yaw, type: 'info', text: `📍 (P:${pitch}°, Y:${yaw}°)` };
                        currentViewer.addHotSpot(buildPannellumHotspotConfig(tempSpot, 0));
                    } catch (e) { }
                }

                // 視覺回饋：顯示已標記
                const flash = document.createElement('div');
                flash.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(16,172,132,0.9);color:#fff;padding:16px 28px;border-radius:16px;font-size:18px;font-weight:700;z-index:100000;pointer-events:none;animation:fadeOut 0.8s ease forwards;';
                flash.textContent = `📍 已標記！ (P:${pitch}°, Y:${yaw}°)`;
                document.body.appendChild(flash);
                setTimeout(() => { flash.remove(); }, 1200);
            }, 200);
        };

        viewerContainer.addEventListener('click', window.__panoClickHandler);
        viewerContainer.style.cursor = isAdminMode ? 'crosshair' : 'default';

        // 在管理員模式下顯示說明浮層
        if (isAdminMode) {
            let hint = document.getElementById('panoMarkHint');
            if (!hint) {
                hint = document.createElement('div');
                hint.id = 'panoMarkHint';
                hint.style.cssText = 'position:absolute;top:100px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:600;z-index:10001;pointer-events:none;text-align:center;backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);';
                hint.textContent = '🖱️ 點擊全景畫面即可標記熱點位置';
                document.getElementById('panorama-overlay')?.appendChild(hint);
                setTimeout(() => { hint.style.opacity = '0'; hint.style.transition = 'opacity 1s'; setTimeout(() => hint.remove(), 1500); }, 3000);
            }
        }
    }, 800);
}


function renderPanoramaMiniMap(activePointId) {
    const miniMap = document.getElementById('panorama-mini-map');
    const canvas = document.getElementById('panorama-mini-map-canvas');
    const label = document.getElementById('panorama-mini-map-current');
    if (!miniMap || !canvas) return;
    miniMap.style.display = 'flex';

    if (!canvas.style.minHeight || canvas.style.minHeight === '0px') {
        canvas.style.minHeight = '280px';
    }

    image360Points = Array.isArray(image360Points) ? image360Points : [];
    const rootPath = (location && location.origin) ? location.origin : '';
    const candidate1 = rootPath + (isTopMap ? '/page_picture/TYK_map_top.jpg' : '/page_picture/TYK_map.jpg');
    const candidate2 = (isTopMap ? './page_picture/TYK_map_top.jpg' : './page_picture/TYK_map.jpg');
    const currentImage = candidate1;
    canvas.innerHTML = '';

    const mapLayer = document.createElement('div');
    mapLayer.className = 'panorama-mini-map-layer';

    const mapImg = document.createElement('img');
    mapImg.alt = '校園導覽地圖';
    mapImg.draggable = false;
    mapImg.dataset.triedAlt = '0';
    const setSrc = (src) => {
        try { mapImg.src = src; } catch (e) { }
    };
    setSrc(currentImage);

    mapImg.addEventListener('load', () => {
        mapImg.style.opacity = '1';
        try { syncLayout(); } catch (e) { }
    });

    mapImg.addEventListener('error', () => {
        if (mapImg.dataset.triedAlt === '0') {
            mapImg.dataset.triedAlt = '1';
            setSrc(candidate2);
            return;
        }
        mapImg.style.opacity = '0';
        mapLayer.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.04))';
    });

    mapLayer.appendChild(mapImg);
    canvas.appendChild(mapLayer);

    const ratio = (map && map.naturalWidth) ? (map.naturalHeight / map.naturalWidth) : 0.83;
    const mapW = 3800;
    const mapH = Math.round(mapW * ratio);
    const previewPoint = (image360Points.find ? image360Points.find(item => item.id === activePointId) : null) || image360Points[0] || null;

    const toPoint = (point) => {
        let x = Number(point && point.x);
        let y = Number(point && point.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (x < 100) x = (x / 100) * mapW;
        if (y < 100) y = (y / 100) * mapH;
        return { x: x, y: y };
    };

    // 過濾樓層
    let filteredPoints = image360Points;
    if (currentFloor) {
        filteredPoints = image360Points.filter(p => p.floor === currentFloor);
    }

    const drawDots = (displayW, displayH) => {
        mapLayer.querySelectorAll('.panorama-mini-dot').forEach(node => node.remove());
        if (!filteredPoints || !filteredPoints.length) return;
        filteredPoints.forEach(point => {
            const pos = toPoint(point);
            if (!pos) return;
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'panorama-mini-dot' + (point.id === activePointId ? ' active' : '');
            dot.style.left = ((pos.x / mapW) * displayW) + 'px';
            dot.style.top = ((pos.y / mapH) * displayH) + 'px';
            dot.title = point.title || '360 點位';
            dot.addEventListener('click', function (e) {
                e.stopPropagation();
                const url = resolvePanoUrl(point.panoUrl || '');
                if (url) openPanoramaMode(url, point.id);
            });
            mapLayer.appendChild(dot);
        });
    };

    const syncLayout = () => {
        try {
            const cw = Math.max(1, Math.round(canvas.clientWidth || canvas.getBoundingClientRect().width));
            const desiredH = Math.max(1, Math.round(cw * (mapH / mapW)));
            canvas.style.height = desiredH + 'px';
        } catch (e) { }

        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const fitScale = Math.min(rect.width / mapW, rect.height / mapH);
        const displayW = Math.max(1, Math.round(mapW * fitScale));
        const displayH = Math.max(1, Math.round(mapH * fitScale));
        const offsetX = Math.round((rect.width - displayW) / 2);
        const offsetY = Math.round((rect.height - displayH) / 2);

        mapLayer.style.width = displayW + 'px';
        mapLayer.style.height = displayH + 'px';
        mapLayer.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px)';
        mapImg.style.width = '100%';
        mapImg.style.height = '100%';

        drawDots(displayW, displayH);

        if (label) {
            const title = (previewPoint && previewPoint.title) ? previewPoint.title : '360 ??';
            label.textContent = '目前：' + title;
        }
    };

    mapImg.addEventListener('load', () => { syncLayout(); });
    if (mapImg.complete) syncLayout();

    const resizeObserver = new ResizeObserver(() => { syncLayout(); });
    resizeObserver.observe(canvas);
}

function closePanoramaMode() {
    const overlay = document.getElementById('panorama-overlay');
    if (overlay) overlay.style.display = 'none';
    hidePanoramaLoadingOverlay();
    if (currentViewer) {
        currentViewer.destroy();
        currentViewer = null;
    }
    if (panoramaViewerInstance) {
        panoramaViewerInstance.destroy();
        panoramaViewerInstance = null;
    }
}

window.openPanoramaMode = openPanoramaMode;
window.closePanoramaMode = closePanoramaMode;

async function loadPermanentMarkers() {
    try {
        const res = await fetch(`${API_BASE}/api/markers`);
        if (!res.ok) return;
        allMarkersData = await res.json();
        renderAllMarkers();
        if (typeof refreshEditDropdown === 'function') {
            refreshEditDropdown();
        }
        if (typeof initFloorSelector === 'function') {
            initFloorSelector();
        }
    } catch (err) {
        console.error('loadPermanentMarkers failed', err);
    }
}

let popupGalleryCurrentIndex = 0;
function injectPopupContent(popup, data, load360 = false) {
    if (activePanoViewer) {
        activePanoViewer.destroy();
        activePanoViewer = null;
    }
    if (popupInlinePanoViewer) {
        popupInlinePanoViewer.destroy();
        popupInlinePanoViewer = null;
    }

    // 收集所有圖片來源，以解析後的URL做去重
    const rawImages = [
        ...(Array.isArray(data.images) ? data.images : []),
        ...(Array.isArray(data.imageFiles) ? data.imageFiles : []),
        ...(data.image ? [data.image] : []),
    ].filter(Boolean);

    // 不再排除 panoUrl：讓所有圖片（含 panoUrl）都在 gallery 中顯示。
    // 若該圖片為 360 類型，renderMedia 會自動用 pannellum 檢視器顯示。
    // 消除重複 URL 但保留 panoUrl 在 gallery 中
    const panoResolved = null; // 永遠不排除
    const dedupMap = new Map();
    rawImages.forEach(f => { const r = resolvePanoUrl(f); if (r) dedupMap.set(r, f); });
    const images = Array.from(dedupMap.values());
    popupGalleryCurrentIndex = 0;

    // 🆕 管理員模式下不顯示全螢幕按鈕
    const isAdminMode = document.getElementById('admin-panel') !== null;
    const fullscreenBtn = isAdminMode ? '' : `<button class="popup-fullscreen-btn" id="popupFullscreenBtn" title="切換全螢幕">⤢</button>`;

    let htmlContent = `
        <div class="popup-header">
            <div class="popup-header-title">
                <strong>${data.title || ''}</strong>
                ${fullscreenBtn}
            </div>
            <button class="popup-close-btn" id="popupCloseX">×</button>
        </div>
        <div class="popup-description">${data.desc || ''}</div>
    `;

    // ✨ Gallery 保留所有圖片（含 360 圖片）
    if (images.length > 0) {
        htmlContent += `<div class="popup-gallery">
            <div class="popup-gallery-viewer">
                <div id="popupGalleryMedia" class="popup-gallery-media"></div>
                <div class="popup-gallery-counter" id="popupGalleryCounter">1 / ${images.length}</div>
                <button class="popup-gallery-nav prev" id="popupGalleryPrev">‹</button>
                <button class="popup-gallery-nav next" id="popupGalleryNext">›</button>
                <button class="popup-gallery-fs-btn" id="popupGalleryFsBtn" title="全螢幕檢視">⛶</button>
            </div>
            <div class="popup-gallery-thumbs">${images.map((file, index) => `<img src="${resolvePanoUrl(file)}" alt="${file}" class="popup-thumb ${index === 0 ? 'active' : ''}" data-index="${index}" loading="lazy" />`).join('')}</div>
        </div>`;
    }

    popup.innerHTML = htmlContent;

    const closeBtn = document.getElementById('popupCloseX');
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeGlobalPopup(); });

    // 🆕 只有非管理員模式才綁定全螢幕按鈕
    const fsBtn = document.getElementById('popupFullscreenBtn');
    if (fsBtn && !isAdminMode) {
        fsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleGlobalPopupFullscreen(); });
    }
    if (images.length > 0) {
        const mediaSlot = document.getElementById('popupGalleryMedia');
        const counter = document.getElementById('popupGalleryCounter');
        const prevBtn = document.getElementById('popupGalleryPrev');
        const nextBtn = document.getElementById('popupGalleryNext');
        const fsImgBtn = document.getElementById('popupGalleryFsBtn');
        const thumbs = popup.querySelectorAll('.popup-thumb');
        const imageSources = images.map((f) => resolvePanoUrl(f));

        function renderMedia(idx) {
            popupGalleryCurrentIndex = idx;
            const currentSource = imageSources[idx] || '';
            if (counter) counter.textContent = (idx + 1) + ' / ' + images.length;
            thumbs.forEach((t, i) => t.classList.toggle('active', i === idx));

            if (!mediaSlot) return;
            if (popupInlinePanoViewer) {
                popupInlinePanoViewer.destroy();
                popupInlinePanoViewer = null;
            }

            if (is360ImageFile(currentSource)) {
                mediaSlot.innerHTML = '<div id="popupGalleryPanorama" class="popup-panorama-inline"></div>';
                setTimeout(() => {
                    try {
                        popupInlinePanoViewer = pannellum.viewer('popupGalleryPanorama', {
                            type: 'equirectangular',
                            panorama: currentSource,
                            autoLoad: true,
                            compass: false,
                            showControls: true,
                            hfov: 60
                        });
                        scheduleHotspotRender(popupInlinePanoViewer, images[idx] || currentSource);
                    } catch (err) {
                        console.error('popup 360 viewer failed', err);
                    }
                }, 20);
                return;
            }

            mediaSlot.innerHTML = `<img id="popupGalleryMain" src="${currentSource}" alt="${images[idx]}" class="popup-gallery-main-img" />`;
            const mainImg = document.getElementById('popupGalleryMain');
            if (mainImg) {
                mainImg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showImageFullscreen(imageSources, popupGalleryCurrentIndex, data.title || '圖片');
                });
            }
        }

        if (prevBtn) prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            renderMedia((popupGalleryCurrentIndex - 1 + images.length) % images.length);
        });
        if (nextBtn) nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            renderMedia((popupGalleryCurrentIndex + 1) % images.length);
        });
        if (fsImgBtn) fsImgBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentSource = imageSources[popupGalleryCurrentIndex] || '';
            if (is360ImageFile(currentSource)) {
                openPanoramaMode(currentSource, data.id);
                return;
            }
            showImageFullscreen(imageSources, popupGalleryCurrentIndex, data.title || '圖片');
        });
        thumbs.forEach((thumb, idx) => thumb.addEventListener('click', (e) => {
            e.stopPropagation();
            renderMedia(idx);
        }));

        renderMedia(0);
    }

}

function toggleGlobalPopupFullscreen() {
    const popup = document.getElementById('global-map-popup');
    if (!popup) return;
    popup.classList.toggle('fullscreen');
    document.body.classList.toggle('global-popup-fullscreen-active', popup.classList.contains('fullscreen'));
}

let currentFullScreenImages = [];
let currentFullScreenIndex = 0;

function ensureImageFullscreenOverlay() {
    let overlay = document.getElementById('image-fullscreen-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'image-fullscreen-overlay';
    overlay.className = 'image-fullscreen-overlay';
    overlay.innerHTML = `
        <button id="fullscreenImageCloseBtn" class="fullscreen-image-close" aria-label="關閉大圖">×</button>
        <button id="fullscreenImagePrevBtn" class="fullscreen-image-nav prev" aria-label="上一張">‹</button>
        <button id="fullscreenImageNextBtn" class="fullscreen-image-nav next" aria-label="下一張">›</button>
        <img id="fullscreenImageContent" src="" alt="" />
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeImageFullscreen();
    });
    document.body.appendChild(overlay);
    document.getElementById('fullscreenImageCloseBtn').addEventListener('click', closeImageFullscreen);
    document.getElementById('fullscreenImagePrevBtn').addEventListener('click', () => navigateFullscreenImage(-1));
    document.getElementById('fullscreenImageNextBtn').addEventListener('click', () => navigateFullscreenImage(1));
    return overlay;
}

function showImageFullscreen(images, index = 0, alt = '') {
    currentFullScreenImages = Array.isArray(images) ? images : [];
    currentFullScreenIndex = Math.max(0, Math.min(currentFullScreenImages.length - 1, index));
    const currentSource = currentFullScreenImages[currentFullScreenIndex] || '';
    if (is360ImageFile(currentSource)) {
        openPanoramaMode(currentSource);
        return;
    }
    const overlay = ensureImageFullscreenOverlay();
    const imageEl = document.getElementById('fullscreenImageContent');
    if (!imageEl) return;
    imageEl.src = currentSource;
    imageEl.alt = alt;
    overlay.classList.add('active');
}

function navigateFullscreenImage(direction) {
    if (!currentFullScreenImages.length) return;
    currentFullScreenIndex = (currentFullScreenIndex + direction + currentFullScreenImages.length) % currentFullScreenImages.length;
    const imageEl = document.getElementById('fullscreenImageContent');
    if (imageEl) imageEl.src = currentFullScreenImages[currentFullScreenIndex];
}

function closeImageFullscreen() {
    const overlay = document.getElementById('image-fullscreen-overlay');
    if (overlay) overlay.classList.remove('active');
}

window.toggleGlobalPopupFullscreen = toggleGlobalPopupFullscreen;
window.showImageFullscreen = showImageFullscreen;
window.closeImageFullscreen = closeImageFullscreen;

document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('image-fullscreen-overlay');
    if (!overlay || !overlay.classList.contains('active')) return;
    if (e.key === 'Escape') closeImageFullscreen();
    if (e.key === 'ArrowLeft') navigateFullscreenImage(-1);
    if (e.key === 'ArrowRight') navigateFullscreenImage(1);
});

// ===== Toast 提示系統（取代 alert）=====
function showToast(message, duration = 3000) {
    // 移除現有的 toast
    const existingToast = document.querySelector('.custom-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'custom-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 100px;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: linear-gradient(135deg, rgba(16, 172, 132, 0.95), rgba(5, 150, 105, 0.95));
        color: #fff;
        padding: 14px 24px;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 700;
        box-shadow: 0 10px 30px rgba(16, 172, 132, 0.4);
        z-index: 100000;
        opacity: 0;
        transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.2);
        max-width: 90vw;
        text-align: center;
    `;

    document.body.appendChild(toast);

    // 動畫進入
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
    });

    // 自動消失
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// 統一隱藏載入畫面：先補滿進度條，再淡出
function tryHideLoading() {
    if (!loaderReady || !loaderMinTimePassed) return;

    // 補滿進度條到 100%
    const progressFill = document.getElementById('loaderProgressFill');
    if (progressFill) progressFill.style.width = '100%';

    // 清除進度條定時器
    if (window.__loaderInterval) {
        clearInterval(window.__loaderInterval);
        window.__loaderInterval = null;
    }

    // 淡出載入畫面
    const ls = document.getElementById('loading-screen');
    if (ls && ls.style.display !== 'none') {
        setTimeout(() => {
            ls.style.opacity = '0';
            setTimeout(() => { try { ls.style.display = 'none'; } catch (e) { } }, 800);
        }, 300);
    }
}

// DOMContentLoaded: 標記 ready 並嘗試隱藏
document.addEventListener("DOMContentLoaded", () => {
    loaderReady = true;
    tryHideLoading();
}, { once: true });

// 備用：window load 時再次確保載入畫面已隱藏
window.addEventListener('load', () => {
    loaderReady = true;
    tryHideLoading();
});

function initPanoramaMiniMapDrag() {
    const miniMap = document.getElementById('panorama-mini-map');
    const overlay = document.getElementById('panorama-overlay');
    if (!miniMap || !overlay || miniMap.dataset.dragInitialized) return;
    miniMap.dataset.dragInitialized = '1';
    miniMap.style.touchAction = 'none';
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startBottom = 0;

    miniMap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.panorama-mini-map-canvas') || e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseInt(getComputedStyle(miniMap).left, 10) || 26;
        startBottom = parseInt(getComputedStyle(miniMap).bottom, 10) || 26;
        miniMap.setPointerCapture(e.pointerId);
        miniMap.style.cursor = 'grabbing';
        e.preventDefault();
    });

    miniMap.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        const overlayRect = overlay.getBoundingClientRect();
        const panelRect = miniMap.getBoundingClientRect();
        const newLeft = Math.min(Math.max(10, startLeft + deltaX), overlayRect.width - panelRect.width - 10);
        const newBottom = Math.min(Math.max(10, startBottom - deltaY), overlayRect.height - panelRect.height - 10);
        miniMap.style.left = newLeft + 'px';
        miniMap.style.bottom = newBottom + 'px';
    });

    const stopDragging = () => {
        if (!isDragging) return;
        isDragging = false;
        miniMap.style.cursor = 'grab';
    };

    miniMap.addEventListener('pointerup', stopDragging);
    miniMap.addEventListener('pointercancel', stopDragging);
}

function initPanoramaMiniMapZoomResize() {
    const miniMap = document.getElementById('panorama-mini-map');
    const canvas = document.getElementById('panorama-mini-map-canvas');
    const zoomInBtn = document.getElementById('miniMapZoomIn');
    const zoomOutBtn = document.getElementById('miniMapZoomOut');
    const resetBtn = document.getElementById('miniMapReset');
    const handle = document.getElementById('miniMapResizeHandle');
    if (!miniMap || !canvas) return;

    if (!miniMap.dataset) miniMap.dataset = {};
    const DEFAULT_WIDTH = 420;
    if (!miniMap.dataset.miniMapScale) miniMap.dataset.miniMapScale = '1.0';
    if (!miniMap.dataset.miniMapWidth) miniMap.dataset.miniMapWidth = String(DEFAULT_WIDTH);

    function applyMiniMapScale(scale) {
        scale = Math.max(0.35, Math.min(2.0, scale));
        miniMap.dataset.miniMapScale = String(scale);
        const baseW = parseFloat(miniMap.dataset.miniMapWidth) || DEFAULT_WIDTH;
        const newW = Math.round(baseW * scale);
        miniMap.style.width = Math.min(newW, window.innerWidth - 52) + 'px';
        window.dispatchEvent(new Event('resize'));
    }

    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = parseFloat(miniMap.dataset.miniMapScale) || 1.0;
            applyMiniMapScale(cur + 0.2);
        });
    }
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = parseFloat(miniMap.dataset.miniMapScale) || 1.0;
            applyMiniMapScale(cur - 0.2);
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            miniMap.dataset.miniMapScale = '1.0';
            applyMiniMapScale(1.0);
        });
    }

    if (handle) {
        let isResizing = false;
        let startX = 0, startY = 0;
        let startW = 0, startH = 0;

        handle.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = miniMap.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            handle.setPointerCapture(e.pointerId);
        });

        document.addEventListener('pointermove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newW = Math.max(200, Math.min(window.innerWidth - 52, startW + dx));
            const newH = Math.max(150, Math.min(window.innerHeight * 0.85, startH + dy));
            miniMap.style.width = newW + 'px';
            miniMap.style.height = newH + 'px';
            miniMap.dataset.miniMapScale = '1.0';
            miniMap.dataset.miniMapWidth = String(newW);
            window.dispatchEvent(new Event('resize'));
        });

        const stopResize = () => {
            if (!isResizing) return;
            isResizing = false;
        };
        document.addEventListener('pointerup', stopResize);
        document.addEventListener('pointercancel', stopResize);
    }
}

function togglePanoramaMapMode() {
    isPegmanModeActive = !isPegmanModeActive;
    renderAllMarkers();

    // 更新頁籤按鈕狀態
    const mapTabBtn = document.querySelector('.mode-tab-btn[data-tab="map"]');
    const panoTabBtn = document.querySelector('.mode-tab-btn[data-tab="pano360"]');
    if (mapTabBtn) mapTabBtn.classList.toggle('active', !isPegmanModeActive);
    if (panoTabBtn) panoTabBtn.classList.toggle('active', isPegmanModeActive);
}

// 綁定地圖/360頁籤切換按鈕
document.addEventListener('DOMContentLoaded', function () {
    const mapTabBtn = document.querySelector('.mode-tab-btn[data-tab="map"]');
    const panoTabBtn = document.querySelector('.mode-tab-btn[data-tab="pano360"]');

    if (mapTabBtn) {
        mapTabBtn.addEventListener('click', function () {
            if (isPegmanModeActive) {
                togglePanoramaMapMode();
            }
        });
    }

    if (panoTabBtn) {
        panoTabBtn.addEventListener('click', function () {
            if (!isPegmanModeActive) {
                togglePanoramaMapMode();
            }
        });
    }
});

function openPanoramaViewer(imageUrl) {
    openPanoramaMode(imageUrl);
}

function initAdminEngine() {
    // 支援新舊 ID（舊版 btnModeAdd/Edit/Image，新版 btnMenuAdd/Edit/Image）
    const addBtn = document.getElementById('btnModeAdd') || document.getElementById('btnMenuAdd');
    const editBtn = document.getElementById('btnModeEdit') || document.getElementById('btnMenuEdit');
    const imageBtn = document.getElementById('btnModeImage') || document.getElementById('btnMenuImage');
    // 也綁定右側快速選單項目
    const quickItems = document.querySelectorAll('.admin-quick-item');
    quickItems.forEach(item => {
        item.addEventListener('click', () => {
            const mode = item.dataset.mode;
            if (mode) updateAdminMode(mode);
        });
    });
    const editSelectSection = document.getElementById('edit-select-section');
    const imageManagementSection = document.getElementById('image-management-section');
    const pointSettingsSection = document.getElementById('point-settings-section');
    const saveActionSection = document.getElementById('save-action-section');
    const aimHint = document.getElementById('aim-hint');
    const btnActivateAim = document.getElementById('btnActivateAim');
    const modalMarkBtn = document.getElementById('modalMarkOnMapBtn');
    const modalPhotoX = document.getElementById('modalPhotoX');
    const modalPhotoY = document.getElementById('modalPhotoY');
    const photoLocationHint = document.getElementById('photoLocationHint');
    const imageFileInput = document.getElementById('imageFileInput');
    const btnSelectFile = document.getElementById('btnSelectFile');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const modalSaveBtn = document.getElementById('modalSaveBtn');
    const modalBtnSet360 = document.getElementById('modalBtnSet360');
    const modalBtnSetNormal = document.getElementById('modalBtnSetNormal');
    const uploadedImageGallery = document.getElementById('uploadedImageGallery');
    const markerImageSelect = document.getElementById('markerImageSelect');

    // 儲存各元素的原始顯示狀態，以便恢復
    const _origDisplay = {};

    // 在瞄準模式時，暫時讓地圖標記不攔截點擊事件，讓點擊穿透到地圖
    const setMarkersPointerEvents = (enabled) => {
        document.querySelectorAll('.custom-layer-marker').forEach(el => {
            el.style.pointerEvents = enabled ? 'auto' : 'none';
        });
    };

    // 記憶元素顯示狀態並隱藏/恢復
    const toggleElementDisplay = (el, hide) => {
        if (!el) return;
        if (hide) {
            // 第一次隱藏時記住原始狀態（只記一次）
            if (!el._origDisplaySaved) {
                el._origDisplaySaved = true;
                el._origDisplayValue = el.style.display;
            }
            el.style.display = 'none';
        } else {
            // 只有之前確實隱藏過才恢復，否則不動
            if (el._origDisplaySaved) {
                el.style.display = el._origDisplayValue;
                delete el._origDisplaySaved;
                delete el._origDisplayValue;
            }
        }
    };

    const setAimMode = (active) => {
        isCapturingPhotoLocation = active;
        setMarkersPointerEvents(!active); // 瞄準模式時讓標記不攔截點擊

        // 🆕 瞄準時隱藏管理面板 & 右側欄，讓地圖完整顯示方便點擊
        const adminPanel = document.getElementById('admin-panel');
        const userSidebar = document.querySelector('.admin-user-sidebar');
        toggleElementDisplay(adminPanel, active);
        toggleElementDisplay(userSidebar, active);

        if (aimHint) aimHint.style.display = active ? 'block' : 'none';

        // 更新按鈕狀態和文字
        if (btnActivateAim) {
            btnActivateAim.classList.toggle('aiming', active);
            const aimText = btnActivateAim.querySelector('.aim-text');
            if (aimText) {
                aimText.textContent = active ? '✖ 取消瞄準' : '點擊地圖設定位置';
            }
        }

        // 顯示/隱藏狀態指示器
        const aimStatus = document.getElementById('aimStatus');
        if (aimStatus) {
            aimStatus.style.display = active ? 'flex' : 'none';
        }
    };

    const setModalAimMode = (active) => {
        isModalAiming = active;
        setMarkersPointerEvents(!active); // 瞄準模式時讓標記不攔截點擊

        // 🆕 Modal 瞄準時也隱藏設定 Modal、管理面板 & 右側欄，讓地圖完整顯示
        const modal = document.getElementById('uploadSettingsModal');
        const adminPanel = document.getElementById('admin-panel');
        const userSidebar = document.querySelector('.admin-user-sidebar');
        toggleElementDisplay(modal, active);
        toggleElementDisplay(adminPanel, active);
        toggleElementDisplay(userSidebar, active);

        if (modalPhotoX && modalPhotoY && photoLocationHint) {
            photoLocationHint.textContent = active
                ? '請在地圖上點擊位置以設定上傳照片的拍攝座標。'
                : '已停止拍攝位置設定。';
            photoLocationHint.style.color = active ? '#0f766e' : '#475569';
        }
        if (modalMarkBtn) modalMarkBtn.textContent = active ? '取消地圖標記' : '📌 在地圖上標記位置';
    };

    const updateAdminMode = (mode) => {
        currentAdminMode = mode;
        if (addBtn) addBtn.classList.toggle('active', mode === 'add');
        if (editBtn) editBtn.classList.toggle('active', mode === 'edit');
        if (imageBtn) imageBtn.classList.toggle('active', mode === 'image');
        if (editSelectSection) editSelectSection.style.display = mode === 'edit' ? 'block' : 'none';
        if (imageManagementSection) {
            imageManagementSection.classList.toggle('hidden-mode', mode !== 'image');
            imageManagementSection.style.display = mode === 'image' ? 'block' : 'none';
        }
        if (pointSettingsSection) pointSettingsSection.style.display = mode === 'image' ? 'none' : 'block';
        if (saveActionSection) saveActionSection.style.display = mode === 'image' ? 'none' : 'block';
        setAimMode(false);
        setModalAimMode(false);
    };

    if (addBtn) addBtn.addEventListener('click', () => updateAdminMode('add'));
    if (editBtn) editBtn.addEventListener('click', () => updateAdminMode('edit'));
    if (imageBtn) imageBtn.addEventListener('click', () => updateAdminMode('image'));
    if (btnActivateAim) btnActivateAim.addEventListener('click', (e) => {
        e.stopPropagation();
        setAimMode(!isCapturingPhotoLocation);
    });
    if (modalMarkBtn) modalMarkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setModalAimMode(!isModalAiming);
    });

    if (imageManagementSection && imageBtn) {
    }

    if (modalCancelBtn) {
        modalCancelBtn.addEventListener('click', () => {
            const modal = document.getElementById('uploadSettingsModal');
            if (modal) modal.style.display = 'none';
            setModalAimMode(false);
        });
    }
    if (modalBtnSet360) modalBtnSet360.addEventListener('click', () => {
        const typeInput = document.getElementById('modalImageType');
        if (typeInput) typeInput.value = '360';
        onPhotoTypeChange();
    });
    if (modalBtnSetNormal) modalBtnSetNormal.addEventListener('click', () => {
        const typeInput = document.getElementById('modalImageType');
        if (typeInput) typeInput.value = 'normal';
        onPhotoTypeChange();
    });
    if (modalSaveBtn) {
        modalSaveBtn.addEventListener('click', async () => {
            const pendingFile = window.__pendingImageFile;
            const modalFileName = document.getElementById('modalImageFilename')?.value?.trim();
            if (!pendingFile && !modalFileName) return;

            const meta = {
                title: document.getElementById('modalImageTitle')?.value?.trim() || '',
                desc: document.getElementById('modalImageDesc')?.value?.trim() || '',
                type: document.getElementById('modalImageType')?.value || 'normal',
                tags: (document.getElementById('modalImageTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
                floor: document.getElementById('modalImageFloor')?.value?.trim() || '',
                photoX: document.getElementById('modalPhotoX')?.value || '',
                photoY: document.getElementById('modalPhotoY')?.value || '',
                defaultZoom: '1.5'
            };

            try {
                let finalFilename = modalFileName;
                if (pendingFile) {
                    const uploadResult = await uploadPendingImage(pendingFile, meta.type);
                    finalFilename = uploadResult.filename || finalFilename || pendingFile.name;
                }

                if (!finalFilename) return;

                await syncLocalMetaToServer(finalFilename, meta);
                document.getElementById('modalImageFilename').value = finalFilename;
                window.__pendingImageFile = null;
                localStorage.removeItem('pendingImageToSet');
                localStorage.removeItem('pendingImageType');

                const fileInput = document.getElementById('imageFileInput');
                if (fileInput) fileInput.value = '';
                const uploadStatusMessage = document.getElementById('uploadStatusMessage');
                if (uploadStatusMessage) uploadStatusMessage.textContent = `已上傳：${finalFilename}`;

                const modal = document.getElementById('uploadSettingsModal');
                if (modal) modal.style.display = 'none';

                await loadUploadedImagesList();
                await loadUploaded360Points();
            } catch (err) {
                console.error('image upload failed', err);
                alert(err.message || '圖片上傳失敗');
            }
        });
    }
    if (markerImageSelect) {
        markerImageSelect.addEventListener('change', () => {
            updatePanoThumbnailPreview();
        });
    }

    const captureAdminMapClick = (e) => {
        if (!isAdminMode || (!isCapturingPhotoLocation && !isModalAiming)) return;
        if (e.target.closest('.custom-layer-marker') || e.target.closest('.admin-sidebar') || e.target.closest('#admin-panel')) return;

        const mapW = map.offsetWidth || 3800;
        const mapH = map.offsetHeight || 2800;

        const mapRect = map.getBoundingClientRect();
        if (!mapRect.width || !mapRect.height) return;

        const clickX = e.clientX;
        const clickY = e.clientY;

        const relX = clickX - mapRect.left;
        const relY = clickY - mapRect.top;

        const imageX = Math.round((relX / mapRect.width) * mapW);
        const imageY = Math.round((relY / mapRect.height) * mapH);

        const showPreviewMarker = (x, y) => {
            let preview = document.getElementById('admin-preview-marker');
            if (!preview) {
                preview = document.createElement('div');
                preview.id = 'admin-preview-marker';
                preview.className = 'custom-layer-marker';
                preview.style.position = 'absolute';
                preview.style.backgroundColor = '#ff006e';
                preview.style.border = '2px solid #c2185b';
                preview.style.boxShadow = '0 0 10px #ff006e';
                preview.style.zIndex = '9998';
                preview.innerText = '📍';
                preview.title = `座標: ${x}, ${y}`;
                const markerContainer = document.getElementById('marker-container');
                if (markerContainer) markerContainer.appendChild(preview);
            }
            preview.style.left = `${x}px`;
            preview.style.top = `${y}px`;
            preview.style.display = 'block';
        };

        if (isCapturingPhotoLocation) {
            const markerX = document.getElementById('markerX');
            const markerY = document.getElementById('markerY');
            if (markerX) markerX.value = imageX;
            if (markerY) markerY.value = imageY;
            showPreviewMarker(imageX, imageY);
            setAimMode(false);

            // 🆕 顯示成功提示（取代 alert）
            showToast(`✅ 已設定座標：X=${imageX}，Y=${imageY}`);
        }

        if (isModalAiming) {
            if (modalPhotoX) modalPhotoX.value = imageX;
            if (modalPhotoY) modalPhotoY.value = imageY;
            if (photoLocationHint) {
                photoLocationHint.textContent = `已設定拍攝位置：X=${imageX}，Y=${imageY}`;
                photoLocationHint.style.color = '#0f766e';
            }
            showPreviewMarker(imageX, imageY);
            setModalAimMode(false);

            // 🆕 顯示成功提示
            showToast(`✅ 已設定拍攝位置：X=${imageX}，Y=${imageY}`);
        }
    };

    if (map) map.addEventListener('click', captureAdminMapClick);
    updateAdminMode(currentAdminMode);
    refreshEditDropdown();
    loadUploadedImagesList();
    removeDeleteButtonIfExists();
    const btnSave = document.getElementById('btnSaveMarker');
    if (btnSave) btnSave.addEventListener('click', async () => {
        try {
            btnSave.disabled = true;
            await saveMarkersToBackend();
        } catch (e) { console.error('save marker click error', e); }
        finally { btnSave.disabled = false; }
    });
    const btnDelete = document.getElementById('btnDeleteMarker');
    if (btnDelete) btnDelete.addEventListener('click', async () => {
        await deleteMarkerPermanently();
    });
}
async function loadUploadedImagesList() {
    try {
        const [imagesRes, metaRes] = await Promise.all([
            fetch(`${API_BASE}/api/get-uploaded-images`),
            fetch(`${API_BASE}/api/get-image-meta`)
        ]);
        if (!imagesRes.ok || !metaRes.ok) return;
        const images = await imagesRes.json();
        const meta = await metaRes.json();
        window.__uploadedImageMetaCache = meta || {};

        const gallery = document.getElementById('uploadedImageGallery');
        const markerImageSelect = document.getElementById('markerImageSelect');
        if (gallery) gallery.innerHTML = '';
        if (markerImageSelect) markerImageSelect.innerHTML = '';

        if (Array.isArray(images)) {
            images.forEach(filename => {
                const url = resolvePanoUrl(filename);
                const imgWrap = document.createElement('div');
                imgWrap.className = 'uploaded-image-item';
                imgWrap.style.display = 'inline-block';
                imgWrap.style.margin = '6px';
                imgWrap.style.position = 'relative';
                imgWrap.innerHTML = `\n                    <img src="${url}" alt="${filename}" style="width:120px;height:80px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;" />\n                    <button class="uploaded-image-delete" data-fname="${filename}" title="刪除" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:6px;padding:4px;cursor:pointer;">🗑</button>\n                `;
                if (gallery) gallery.appendChild(imgWrap);

                if (markerImageSelect) {
                    const opt = document.createElement('option');
                    opt.value = filename;
                    opt.textContent = filename;
                    markerImageSelect.appendChild(opt);
                }
            });
        }

        document.querySelectorAll('.uploaded-image-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const fname = btn.dataset.fname;
                if (!fname) return;
                if (!confirm(`確定要刪除 ${fname} 嗎？`)) return;
                try {
                    await fetch(`${API_BASE}/api/delete-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: fname }) });
                } catch (err) {
                    console.warn('delete image request failed', err);
                }
                btn.parentElement && btn.parentElement.remove();
            });
        });

    } catch (err) {
        console.warn('loadUploadedImagesList failed', err);
    }
}
function refreshEditDropdown() {
    const selectMarker = document.getElementById('selectMarkerToEdit');
    if (!selectMarker) return;
    const currentValue = selectMarker.value;
    selectMarker.innerHTML = '<option value="">-- 請選擇要編輯的點位 --</option>';
    if (Array.isArray(allMarkersData)) {
        allMarkersData.forEach(marker => {
            if (marker && marker.id && marker.title) {
                const option = document.createElement('option');
                option.value = marker.id;
                option.textContent = marker.title;
                selectMarker.appendChild(option);
            }
        });
    }
    if (currentValue) selectMarker.value = currentValue;
    selectMarker.addEventListener('change', (e) => {
        if (!e.target.value) return;
        const selected = allMarkersData.find(m => m.id === e.target.value);
        if (selected) {
            document.getElementById('markerId').value = selected.id;
            document.getElementById('markerTitle').value = selected.title || '';
            document.getElementById('markerDesc').value = selected.desc || '';
            document.getElementById('markerLabel').value = selected.label || '';
            document.getElementById('markerFloor').value = selected.floor || '';
            document.getElementById('markerX').value = selected.x || '';
            document.getElementById('markerY').value = selected.y || '';
            const zoomInput = document.getElementById('markerZoomScale');
            if (zoomInput) zoomInput.value = selected.zoom || 1.5;
        }
    });
}
function fillFormWithMarker() { }


// ===== 圖片管理系統 v2 =====
let _imgAllData = []; // { filename, type, title, desc }
let _imgSelected = new Set();
let _imgSearchTerm = '';
let _imgFilterType = 'all';

async function loadUploadedImagesList() {
    const gallery = document.getElementById('uploadedImageGallery');
    const markerImageSelect = document.getElementById('markerImageSelect');
    try {
        const [imagesRes, metaRes] = await Promise.all([
            fetch(`${API_BASE}/api/get-uploaded-images`),
            fetch(`${API_BASE}/api/get-image-meta`)
        ]);
        const images = imagesRes.ok ? await imagesRes.json() : [];
        const metaStore = metaRes.ok ? await metaRes.json() : {};
        window.__uploadedImageMetaCache = metaStore || {};

        // 建構完整資料
        _imgAllData = (Array.isArray(images) ? images : []).map(file => {
            const meta = metaStore?.[file] || {};
            return {
                filename: file,
                type: meta.type || meta.imageType || 'normal',
                title: meta.title || '',
                desc: meta.desc || '',
                tags: meta.tags || []
            };
        });

        // 更新 markerImageSelect（點位管理用）— 顯示標題而非檔名
        if (markerImageSelect) {
            const currentSelected = new Set(Array.from(markerImageSelect.selectedOptions).map(opt => opt.value));
            markerImageSelect.innerHTML = '';
            _imgAllData.forEach(d => {
                const option = document.createElement('option');
                option.value = d.filename;
                const displayLabel = d.title || d.filename;
                const typeTag = d.type === '360' ? ' 🌀360' : '';
                option.textContent = `${displayLabel}${typeTag}`;
                option.title = d.filename;
                if (currentSelected.has(d.filename)) option.selected = true;
                markerImageSelect.appendChild(option);
            });
        }

        _renderImageGallery();
        _initImgToolbar();
        _initImgDropZone();
    } catch (err) {
        console.error('loadUploadedImagesList failed', err);
        if (gallery) gallery.innerHTML = '<div class="img-gallery-empty">圖片庫載入失敗</div>';
    }
}

function _renderImageGallery() {
    const gallery = document.getElementById('uploadedImageGallery');
    if (!gallery) return;

    // 篩選
    let filtered = _imgAllData;
    if (_imgFilterType !== 'all') {
        filtered = filtered.filter(d => d.type === _imgFilterType);
    }
    if (_imgSearchTerm) {
        const q = _imgSearchTerm.toLowerCase();
        filtered = filtered.filter(d => d.filename.toLowerCase().includes(q) || (d.title && d.title.toLowerCase().includes(q)));
    }

    // 統計
    const total = _imgAllData.length;
    const count360 = _imgAllData.filter(d => d.type === '360').length;
    const statsTotal = document.getElementById('imgStatsTotal');
    const stats360 = document.getElementById('imgStats360');
    if (statsTotal) statsTotal.textContent = `${total} 張`;
    if (stats360) stats360.textContent = `${count360} 張 360`;

    // 批次列
    const batchBar = document.getElementById('imgBatchBar');
    const batchCount = document.getElementById('imgBatchCount');
    if (batchBar) batchBar.style.display = _imgSelected.size > 0 ? 'flex' : 'none';
    if (batchCount) batchCount.textContent = `已選 ${_imgSelected.size} 張`;

    gallery.innerHTML = '';
    if (!filtered.length) {
        gallery.innerHTML = `<div class="img-gallery-empty">${_imgAllData.length ? '沒有符合條件的圖片' : '📷 還沒有上傳任何圖片，拖曳到上方區域即可上傳！'}</div>`;
        return;
    }

    filtered.forEach(d => {
        const card = document.createElement('div');
        card.className = 'img-card' + (_imgSelected.has(d.filename) ? ' selected' : '');
        card.dataset.filename = d.filename;

        const is360 = d.type === '360';
        const badge = is360 ? '<span class="img-card-badge badge-360">360</span>' : '<span class="img-card-badge badge-normal">一般</span>';

        card.innerHTML = `
            <div class="img-card-check" onclick="event.stopPropagation(); _toggleImgSelect('${d.filename}')">✓</div>
            ${badge}
            <img class="img-card-thumb" src="${resolvePanoUrl(d.filename)}" alt="${d.filename}" loading="lazy" />
            <div class="img-card-info">
                <div class="img-card-name" title="${d.filename}">${d.filename}</div>
                ${d.title ? `<div class="img-card-title" title="${d.title}">🏷️ ${d.title}</div>` : ''}
            </div>
            <div class="img-card-actions">
                <button class="img-action-settings" onclick="event.stopPropagation(); openImageSettingsModal('${d.filename}', window.__uploadedImageMetaCache?.['${d.filename}'] || {})" title="設定">⚙️</button>
                <button class="img-action-delete" onclick="event.stopPropagation(); _deleteSingleImage('${d.filename}')" title="刪除">🗑️</button>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.img-card-actions')) return;
            openImgPreview(resolvePanoUrl(d.filename), d.filename, d.title, is360);
        });

        gallery.appendChild(card);
    });
}

function _initImgToolbar() {
    const searchInput = document.getElementById('imgSearchInput');
    const filterSelect = document.getElementById('imgFilterType');
    if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', (e) => {
            _imgSearchTerm = e.target.value.trim();
            _renderImageGallery();
        });
    }
    if (filterSelect && !filterSelect._bound) {
        filterSelect._bound = true;
        filterSelect.addEventListener('change', (e) => {
            _imgFilterType = e.target.value;
            _renderImageGallery();
        });
    }
}

function _initImgDropZone() {
    const dropZone = document.getElementById('imgDropZone');
    const fileInput = document.getElementById('imageFileInput');
    if (!dropZone || !fileInput || dropZone._bound) return;
    dropZone._bound = true;

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length) _handleImageUploads(files);
    });

    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files.length) _handleImageUploads(files);
        e.target.value = '';
    });
}

async function _handleImageUploads(files) {
    const statusEl = document.getElementById('uploadStatusMessage');
    let uploaded = 0;
    const total = files.length;

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const formData = new FormData();
        formData.append('panoramaImage', file);
        formData.append('imageType', 'normal');
        const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '_');
        formData.append('customFileName', baseName);

        try {
            const res = await fetch(`${API_BASE}/api/upload-image`, { method: 'POST', body: formData });
            if (res.ok) uploaded++;
        } catch (e) { console.warn('upload failed', e); }
    }

    if (statusEl) {
        statusEl.textContent = `✅ 已上傳 ${uploaded}/${total} 張圖片`;
        statusEl.classList.add('has-status');
        setTimeout(() => { statusEl.textContent = ''; statusEl.classList.remove('has-status'); }, 4000);
    }

    await loadUploadedImagesList();
}

function _toggleImgSelect(filename) {
    if (_imgSelected.has(filename)) _imgSelected.delete(filename);
    else _imgSelected.add(filename);
    _renderImageGallery();
}

function _deleteSingleImage(filename) {
    if (!confirm(`確定要刪除 ${filename} 嗎？`)) return;
    fetch(`${API_BASE}/api/delete-image/${encodeURIComponent(filename)}`, { method: 'DELETE' })
        .then(r => r.json()).then(() => loadUploadedImagesList())
        .catch(err => { console.error('delete failed', err); alert('刪除失敗'); });
}

async function imgBatchDelete() {
    if (!_imgSelected.size) return;
    if (!confirm(`確定要刪除已選擇的 ${_imgSelected.size} 張圖片嗎？此操作無法復原！`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/batch-delete-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: Array.from(_imgSelected) })
        });
        const result = await res.json().catch(() => ({}));
        _imgSelected.clear();
        await loadUploadedImagesList();
        alert(result.message || '批次刪除完成');
    } catch (e) {
        console.error('batch delete failed', e);
        alert('批次刪除失敗');
    }
}

async function imgBatchSetType(type) {
    if (!_imgSelected.size) return;
    try {
        const res = await fetch(`${API_BASE}/api/batch-update-image-type`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: Array.from(_imgSelected), imageType: type })
        });
        const result = await res.json().catch(() => ({}));
        _imgSelected.clear();
        await loadUploadedImagesList();
        alert(result.message || '已更新');
    } catch (e) {
        console.error('batch update type failed', e);
        alert('更新失敗');
    }
}

function imgBatchCancel() {
    _imgSelected.clear();
    _renderImageGallery();
}

function openImgPreview(src, filename, title, is360) {
    const modal = document.getElementById('imgPreviewModal');
    const img = document.getElementById('imgPreviewContent');
    const info = document.getElementById('imgPreviewInfo');
    if (!modal || !img) return;
    img.src = src;
    if (info) {
        info.textContent = `${title || filename}${is360 ? ' (360)' : ''}`;
    }
    modal.style.display = 'flex';
    document.addEventListener('keydown', _escPreviewHandler);
}

function closeImgPreview() {
    const modal = document.getElementById('imgPreviewModal');
    if (modal) modal.style.display = 'none';
    document.removeEventListener('keydown', _escPreviewHandler);
}

function _escPreviewHandler(e) {
    if (e.key === 'Escape') closeImgPreview();
}

// 暴露到全域
window.imgBatchDelete = imgBatchDelete;
window.imgBatchSetType = imgBatchSetType;
window.imgBatchCancel = imgBatchCancel;
window.closeImgPreview = closeImgPreview;
window._toggleImgSelect = _toggleImgSelect;
window._deleteSingleImage = _deleteSingleImage;

function refreshEditDropdown() {
    const selectMarker = document.getElementById('selectMarkerToEdit');
    if (!selectMarker) return;
    const currentValue = selectMarker.value;
    selectMarker.innerHTML = '<option value="">-- 請選擇現有點位 --</option>';
    (Array.isArray(allMarkersData) ? allMarkersData : []).forEach(marker => {
        if (!marker || !marker.id) return;
        const option = document.createElement('option');
        option.value = marker.id;
        option.textContent = marker.title ? `${marker.title} (${marker.id})` : marker.id;
        selectMarker.appendChild(option);
    });
    if (currentValue) selectMarker.value = currentValue;
    selectMarker.onchange = () => fillFormWithMarker(selectMarker.value);
}

function fillFormWithMarker(markerId = '') {
    const marker = (allMarkersData || []).find(m => m.id === markerId) || null;
    if (!marker) {
        clearAdminForm();
        return;
    }

    const markerIdInput = document.getElementById('markerId');
    const titleInput = document.getElementById('markerTitle');
    const descInput = document.getElementById('markerDesc');
    const labelInput = document.getElementById('markerLabel');
    const floorInput = document.getElementById('markerFloor');
    const xInput = document.getElementById('markerX');
    const yInput = document.getElementById('markerY');
    const zoomInput = document.getElementById('markerZoomScale');
    const imageSelect = document.getElementById('markerImageSelect');

    if (markerIdInput) markerIdInput.value = marker.id || '';
    if (titleInput) titleInput.value = marker.title || '';
    if (descInput) descInput.value = marker.desc || '';
    if (labelInput) labelInput.value = marker.label || '';
    if (floorInput) floorInput.value = marker.floor || '';
    if (xInput) xInput.value = marker.x ?? '';
    if (yInput) yInput.value = marker.y ?? '';
    if (zoomInput) zoomInput.value = marker.zoom || 1.5;

    if (imageSelect) {
        const selectedFiles = new Set([
            ...(Array.isArray(marker.images) ? marker.images : []),
            ...(Array.isArray(marker.imageFiles) ? marker.imageFiles : []),
            ...(marker.image ? [marker.image] : []),
            ...(marker.panoUrl ? [marker.panoUrl] : [])
        ].filter(Boolean).map(v => getImageFileName(v)));
        Array.from(imageSelect.options).forEach(opt => {
            opt.selected = selectedFiles.has(getImageFileName(opt.value));
        });
    }

    renderPreviewMarker();
    removeDeleteButtonIfExists();
}

function clearAdminForm() {
    ['markerId', 'markerTitle', 'markerDesc', 'markerLabel', 'markerFloor', 'markerX', 'markerY'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const zoomInput = document.getElementById('markerZoomScale');
    if (zoomInput) zoomInput.value = 1.5;
    const selectMarker = document.getElementById('selectMarkerToEdit');
    if (selectMarker) selectMarker.value = '';
    const imageSelect = document.getElementById('markerImageSelect');
    if (imageSelect) Array.from(imageSelect.options).forEach(opt => opt.selected = false);
    clearPreviewMarker();
    removeDeleteButtonIfExists();
}

async function syncLocalMetaToServer(filename = '', meta = null) {
    const fileName = filename || document.getElementById('modalImageFilename')?.value?.trim();
    if (!fileName) return false;
    const payload = meta || {
        title: document.getElementById('modalImageTitle')?.value?.trim() || '',
        desc: document.getElementById('modalImageDesc')?.value?.trim() || '',
        type: document.getElementById('modalImageType')?.value || 'normal',
        tags: (document.getElementById('modalImageTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
        floor: document.getElementById('modalImageFloor')?.value?.trim() || '',
        photoX: document.getElementById('modalPhotoX')?.value || '',
        photoY: document.getElementById('modalPhotoY')?.value || '',
        defaultZoom: '1.5'
    };
    window.__uploadedImageMetaCache = window.__uploadedImageMetaCache || {};
    window.__uploadedImageMetaCache[fileName] = payload;
    const res = await fetch(`${API_BASE}/api/save-image-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fileName, meta: payload })
    });
    return res.ok;
}

function openImageSettingsModal(filename, meta) {
    const modal = document.getElementById('uploadSettingsModal');
    if (!modal) return;
    try {
        document.getElementById('modalImageFilename').value = filename || '';
        document.getElementById('modalImageType').value = (meta && meta.type) ? meta.type : 'normal';
        document.getElementById('modalImageTitle').value = (meta && meta.title) ? meta.title : '';
        document.getElementById('modalImageDesc').value = (meta && meta.desc) ? meta.desc : '';
        document.getElementById('modalImageTags').value = (meta && Array.isArray(meta.tags)) ? meta.tags.join(',') : '';
        document.getElementById('modalImageFloor').value = (meta && meta.floor) ? meta.floor : '';
        document.getElementById('modalPhotoX').value = (meta && meta.photoX) ? meta.photoX : '';
        document.getElementById('modalPhotoY').value = (meta && meta.photoY) ? meta.photoY : '';
        modal.style.display = 'flex';
        if (typeof onPhotoTypeChange === 'function') onPhotoTypeChange();
    } catch (e) { console.error('openImageSettingsModal error', e); }
}

function updatePanoThumbnailPreview() {
    onPhotoTypeChange();
}

function adjustCoord(fieldId, delta) {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const current = parseInt(input.value || '0', 10);
    input.value = String((Number.isFinite(current) ? current : 0) + delta);
    renderPreviewMarker();
}

async function saveMarkersToBackend() {
    const markerId = document.getElementById('markerId')?.value?.trim();
    const title = document.getElementById('markerTitle')?.value?.trim() || '';
    const desc = document.getElementById('markerDesc')?.value?.trim() || '';
    const label = document.getElementById('markerLabel')?.value?.trim() || '';
    const floor = document.getElementById('markerFloor')?.value?.trim() || '';
    const x = parseInt(document.getElementById('markerX')?.value || '0', 10);
    const y = parseInt(document.getElementById('markerY')?.value || '0', 10);
    const zoom = parseFloat(document.getElementById('markerZoomScale')?.value || '1.5');
    const imageSelect = document.getElementById('markerImageSelect');
    const selectedImages = imageSelect ? Array.from(imageSelect.selectedOptions).map(opt => opt.value) : [];
    const panoUrl = selectedImages.find(file => getStoredImageType(file) === '360') || '';
    const activeShapeBtn = document.querySelector('#shapeSelectGroup .shape-select-btn.active');
    const markerShape = activeShapeBtn ? activeShapeBtn.dataset.shape : 'square';
    // 建築密碼開關
    const buildingCodeCheckbox = document.getElementById('markerBuildingCode');
    const buildingCode = buildingCodeCheckbox ? buildingCodeCheckbox.checked : false;
    const payload = {
        id: markerId || `marker-${Date.now()}`,
        title,
        desc,
        label,
        floor,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        zoom: Number.isFinite(zoom) ? zoom : 1.5,
        images: selectedImages,
        panoUrl,
        layer: isTopMap ? 'TYK_map_top' : 'TYK_map',
        shape: markerShape,
        buildingCode: buildingCode
    };
    const exists = (allMarkersData || []).some(m => m.id === payload.id);
    const url = exists ? `${API_BASE}/api/update-marker` : `${API_BASE}/api/add-marker`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.success === false) {
        alert(result.message || '儲存失敗');
        return false;
    }
    await loadPermanentMarkers();
    refreshEditDropdown();
    fillFormWithMarker(payload.id);
    alert('已儲存');
    return true;
}

async function deleteMarkerPermanently() {
    const markerId = document.getElementById('markerId')?.value?.trim();
    if (!markerId) {
        alert('請先選擇要刪除的點位');
        return;
    }
    if (!confirm('確定要永久刪除此點位嗎？')) return;
    const res = await fetch(`${API_BASE}/api/delete-marker/${encodeURIComponent(markerId)}`, { method: 'DELETE' });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.success === false) {
        alert(result.message || '刪除失敗');
        return;
    }
    clearAdminForm();
    await loadPermanentMarkers();
    refreshEditDropdown();
}

function removeDeleteButtonIfExists() {
    const btn = document.getElementById('btnDeleteMarker');
    if (!btn) return;
    const markerId = document.getElementById('markerId')?.value?.trim();
    btn.style.display = currentAdminMode === 'edit' || markerId ? 'block' : 'block';
}

function clearPreviewMarker() {
    if (previewMarker && previewMarker.parentNode) {
        previewMarker.parentNode.removeChild(previewMarker);
    }
    previewMarker = null;
}

function renderPreviewMarker() {
    const container = document.getElementById('marker-container');
    const xInput = document.getElementById('markerX');
    const yInput = document.getElementById('markerY');
    if (!container || !xInput || !yInput) return;
    const x = parseInt(xInput.value || '0', 10);
    const y = parseInt(yInput.value || '0', 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
        clearPreviewMarker();
        return;
    }
    if (!previewMarker) {
        previewMarker = document.createElement('div');
        previewMarker.className = 'aim-preview-marker pulse-animation';
        previewMarker.textContent = '◎';
        container.appendChild(previewMarker);
    }
    previewMarker.style.left = x + 'px';
    previewMarker.style.top = y + 'px';
}

function onPhotoTypeChange() {
    const photoTypeSelect = document.getElementById('photoTypeSelect');
    const modalType = document.getElementById('modalImageType');
    const hint = document.getElementById('photoLocationHint');
    const modalHint = document.getElementById('modalMarkHint');
    const type = (photoTypeSelect && photoTypeSelect.value) || (modalType && modalType.value) || 'normal';
    if (modalType) modalType.value = type;
    if (hint) {
        hint.style.display = type === '360' ? 'block' : 'none';
        hint.textContent = type === '360' ? '360 圖片請先在地圖上標記位置。' : '';
    }
    if (modalHint) {
        modalHint.textContent = type === '360'
            ? '請先按下標記按鈕，再到地圖上點選位置。'
            : '若不是 360 圖片，可以直接儲存。';
    }
    const modalBtnSet360 = document.getElementById('modalBtnSet360');
    const modalBtnSetNormal = document.getElementById('modalBtnSetNormal');
    if (modalBtnSet360) modalBtnSet360.classList.toggle('active', type === '360');
    if (modalBtnSetNormal) modalBtnSetNormal.classList.toggle('active', type !== '360');

    // 更新熱點編輯器按鈕可見性
    updateHotspotEditorButton(type);
}

function updateHotspotEditorButton(imageType) {
    const btnOpenHotspotEditor = document.getElementById('btnOpenHotspotEditor');
    const hotspotEditorHint = document.getElementById('hotspotEditorHint');

    if (btnOpenHotspotEditor && hotspotEditorHint) {
        const is360 = imageType === '360';
        btnOpenHotspotEditor.style.display = is360 ? 'block' : 'none';
        hotspotEditorHint.style.display = is360 ? 'block' : 'none';
    }
}

// ===== 多國語言切換功能 =====
const langTranslations = {
    'zh-TW': {
        home: '首頁',
        tour: '建築密碼',
        about: '關於我們',
        login: '管理登入',
        loading: '載入中',
        layerSettings: '圖層設定',
        allFloors: '全部',
        classroom: '教室',
        building: '棟別',
        zoomIn: '＋',
        zoomOut: '−',
        mode360: '360模式',
        panoramaTitle: '360導覽',
        location: '地點',
        close: '關閉',
        loginTitle: '管理系統登入',
        username: '請輸入管理員帳號',
        password: '請輸入管理員密碼',
        loginBtn: '登入系統',
        loginError: '帳號或密碼錯誤！',
        addMarker: '+ 新增點位',
        editMarker: '✎ 修改點位',
        imageManage: '🖼 圖片管理',
        settings: '⚙ 設定',
        logout: '登出'
    },
    'en': {
        home: 'Home',
        tour: 'Building Codes',
        about: 'About Us',
        login: 'Admin Login',
        loading: 'Loading',
        layerSettings: 'Layer',
        allFloors: 'All',
        classroom: 'Classroom',
        building: 'Building',
        zoomIn: '+',
        zoomOut: '−',
        mode360: '360 Mode',
        panoramaTitle: '360 Tour',
        location: 'Location',
        close: 'Close',
        loginTitle: 'Admin Login',
        username: 'Enter admin account',
        password: 'Enter admin password',
        loginBtn: 'Login',
        loginError: 'Invalid account or password!',
        addMarker: '+ Add Marker',
        editMarker: '✎ Edit Marker',
        imageManage: '🖼 Image Mgmt',
        settings: '⚙ Settings',
        logout: 'Logout'
    },
    'ja': {
        home: 'ホーム',
        tour: '建築コード',
        about: '私たちについて',
        login: '管理ログイン',
        loading: '読み込み中',
        layerSettings: 'レイヤー',
        allFloors: '全て',
        classroom: '教室',
        building: '棟',
        zoomIn: '＋',
        zoomOut: '−',
        mode360: '360モード',
        panoramaTitle: '360ツアー',
        location: '場所',
        close: '閉じる',
        loginTitle: '管理システムログイン',
        username: '管理者アカウントを入力',
        password: '管理者パスワードを入力',
        loginBtn: 'ログイン',
        loginError: 'アカウントまたはパスワードが間違っています！',
        addMarker: '+ マーカー追加',
        editMarker: '✎ マーカー編集',
        imageManage: '🖼 画像管理',
        settings: '⚙ 設定',
        logout: 'ログアウト'
    },
    'ko': {
        home: '홈',
        tour: '건축 코드',
        about: '소개',
        login: '관리자 로그인',
        loading: '로딩 중',
        layerSettings: '레이어',
        allFloors: '전체',
        classroom: '교실',
        building: '동',
        zoomIn: '＋',
        zoomOut: '−',
        mode360: '360 모드',
        panoramaTitle: '360 투어',
        location: '위치',
        close: '닫기',
        loginTitle: '관리자 시스템 로그인',
        username: '관리자 계정 입력',
        password: '관리자 비밀번호 입력',
        loginBtn: '로그인',
        loginError: '계정 또는 비밀번호가 잘못되었습니다!',
        addMarker: '+ 마커 추가',
        editMarker: '✎ 마커 편집',
        imageManage: '🖼 이미지 관리',
        settings: '⚙ 설정',
        logout: '로그아웃'
    }
};

function switchLanguage(lang) {
    try {
        localStorage.setItem('tyk_lang', lang);
        const langText = document.getElementById('langText');
        if (langText) langText.textContent = lang;

        const langMenu = document.getElementById('langMenu');
        if (langMenu) {
            langMenu.querySelectorAll('.lang-menu-item').forEach(item => {
                item.classList.toggle('active', item.dataset.lang === lang);
            });
            langMenu.classList.remove('show');
        }

        // Update nav links
        const navLinks = document.querySelectorAll('.nav-links a');
        const t = langTranslations[lang] || langTranslations['zh-TW'];
        if (navLinks.length >= 4) {
            if (navLinks[0]) navLinks[0].textContent = t.home;
            if (navLinks[1]) navLinks[1].textContent = t.tour;
            if (navLinks[2]) navLinks[2].textContent = t.about;
            if (navLinks[3]) navLinks[3].textContent = t.login;
        }

        // Update layer button
        const layerBtn = document.getElementById('layerMenuBtn');
        if (layerBtn) {
            const textNode = layerBtn.childNodes[0];
            if (textNode) textNode.textContent = t.layerSettings + ' ';
        }

        // Update layer menu items
        document.querySelectorAll('.layer-menu-item').forEach(item => {
            if (item.dataset.layer === 'top') item.textContent = t.classroom;
            if (item.dataset.layer === 'base') item.textContent = t.building;
        });

        // Update 360 button
        const panoBtn = document.getElementById('btnTogglePanoramaMode');
        if (panoBtn) panoBtn.textContent = t.mode360;

        // Update panorama title
        const panoTitle = document.querySelector('.panorama-mini-map-title');
        if (panoTitle) panoTitle.textContent = t.panoramaTitle;

        // Update floor buttons if they exist
        document.querySelectorAll('.layer-floor-btn[data-floor=""]').forEach(btn => {
            btn.textContent = t.allFloors || '全部';
        });

        // Update admin panel buttons if they exist
        const addBtn = document.querySelector('.admin-menu-btn[data-mode="add"]');
        const editBtn = document.querySelector('.admin-menu-btn[data-mode="edit"]');
        const imageBtn = document.querySelector('.admin-menu-btn[data-mode="image"]');
        const settingsBtn = document.querySelector('.admin-menu-btn[data-mode="settings"]');

        if (addBtn) addBtn.textContent = (t.addMarker || '+ 新增點位');
        if (editBtn) editBtn.textContent = (t.editMarker || '✎ 修改點位');
        if (imageBtn) imageBtn.textContent = (t.imageManage || '🖼 圖片管理');
        if (settingsBtn) settingsBtn.textContent = (t.settings || '⚙ 設定');

    } catch (e) {
        console.warn('Language switch error:', e);
    }
}

function initLanguageSwitcher() {
    const langSelector = document.getElementById('langSelector');
    const langMenu = document.getElementById('langMenu');

    if (!langSelector || !langMenu) return;

    // Restore saved language
    const savedLang = localStorage.getItem('tyk_lang') || 'zh-TW';

    langSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        langMenu.classList.toggle('show');
    });

    langMenu.querySelectorAll('.lang-menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const lang = item.dataset.lang;
            switchLanguage(lang);
            langMenu.classList.remove('show');
        });
    });

    document.addEventListener('click', () => {
        langMenu.classList.remove('show');
    });

    // Apply saved language
    switchLanguage(savedLang);

    // Update nav indicator after language change
    setTimeout(() => {
        const indicator = document.getElementById('navIndicator');
        const activeLink = document.querySelector('.nav-links a.active');
        if (indicator && activeLink) {
            indicator.style.width = `${activeLink.offsetWidth}px`;
            indicator.style.left = `${activeLink.offsetLeft}px`;
        }
    }, 50);
}

// ===== 帳號管理系統 =====
// 從後端載入帳號列表
async function loadAccountList() {
    try {
        const res = await fetch(`${API_BASE}/api/accounts`);
        if (!res.ok) {
            // 如果後端不存在，使用預設資料
            renderAccountList(getDefaultAccounts());
            return;
        }
        const accounts = await res.json();
        renderAccountList(accounts);
    } catch (err) {
        console.warn('loadAccountList failed, using defaults:', err);
        renderAccountList(getDefaultAccounts());
    }
}

function getDefaultAccounts() {
    return [
        { id: 'tyk114', username: 'tyk114', role: 'owner', canDelete: false },
        { id: 'editor01', username: 'editor01', role: 'editor', canDelete: true },
        { id: 'editor02', username: 'editor02', role: 'editor', canDelete: true }
    ];
}

function renderAccountList(accounts) {
    const listEl = document.getElementById('accountList');
    if (!listEl) return;

    listEl.innerHTML = accounts.map(acc => `
        <div class="account-item" data-account-id="${acc.id}">
            <div class="account-info">
                <span class="account-name">${acc.username || acc.id}</span>
                <span class="account-role account-role-${acc.role}">${acc.role === 'owner' ? '最大系統管理員帳戶 - 擁有者' : '系統管理員帳戶 - 可編輯者'}</span>
                ${!acc.canDelete ? '<span class="account-badge account-badge-owner">無法刪除</span>' : ''}
            </div>
            ${acc.canDelete ? `<button class="account-delete-btn" data-account-id="${acc.id}" title="刪除帳號">🗑</button>` : ''}
        </div>
    `).join('');

    // 綁定刪除按鈕事件
    listEl.querySelectorAll('.account-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const accountId = btn.dataset.accountId;
            if (!accountId) return;
            if (!confirm('確定要刪除此帳號嗎？')) return;
            await deleteAccount(accountId);
        });
    });
}

async function deleteAccount(accountId) {
    try {
        const res = await fetch(`${API_BASE}/api/delete-account/${encodeURIComponent(accountId)}`, {
            method: 'DELETE'
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok) {
            alert('帳號已刪除');
            loadAccountList();
        } else {
            alert(result.message || '刪除失敗');
        }
    } catch (err) {
        console.error('deleteAccount failed:', err);
        alert('無法連接到伺服器，請確認後端已啟動');
    }
}

// 新增帳號
async function addAccount(username, password, role) {
    if (!username || !password) {
        alert('請輸入帳號和密碼');
        return;
    }
    if (password.length < 6) {
        alert('密碼長度至少需要 6 個字元');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/add-account`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });
        const result = await res.json();
        if (res.ok && result.success) {
            alert('帳號已新增');
            // 清空輸入欄位
            document.getElementById('newAccountName').value = '';
            document.getElementById('newAccountPass').value = '';
            loadAccountList();
        } else {
            alert(result.message || '新增失敗');
        }
    } catch (err) {
        console.error('addAccount failed:', err);
        alert('無法連接到伺服器，請確認後端已啟動');
    }
}

// 更改密碼
async function changePassword(newPassword, confirmPassword) {
    if (!newPassword || !confirmPassword) {
        alert('請輸入新密碼和確認密碼');
        return;
    }
    if (newPassword !== confirmPassword) {
        alert('兩次輸入的密碼不一致');
        return;
    }
    if (newPassword.length < 6) {
        alert('密碼長度至少需要 6 個字元');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword })
        });
        const result = await res.json();
        if (res.ok && result.success) {
            alert('密碼已更改');
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';
        } else {
            alert(result.message || '更改失敗');
        }
    } catch (err) {
        console.error('changePassword failed:', err);
        alert('無法連接到伺服器，請確認後端已啟動');
    }
}

// 初始化帳號管理功能
function initAccountManagement() {
    // 載入帳號列表
    loadAccountList();

    // 綁定新增帳號按鈕
    const btnAddAccount = document.getElementById('btnAddAccount');
    if (btnAddAccount) {
        btnAddAccount.addEventListener('click', async () => {
            const username = document.getElementById('newAccountName').value.trim();
            const password = document.getElementById('newAccountPass').value;
            const role = document.getElementById('newAccountRole').value;
            await addAccount(username, password, role);
        });
    }

    // 綁定更改密碼按鈕
    const btnSavePassword = document.getElementById('btnSavePassword');
    if (btnSavePassword) {
        btnSavePassword.addEventListener('click', async () => {
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            await changePassword(newPassword, confirmPassword);
        });
    }
}

// 在 DOMContentLoaded 時初始化帳號管理
if (document.getElementById('accountList')) {
    // 如果 DOMContentLoaded 已經觸發過，直接初始化
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => initAccountManagement(), 500);
    } else {
        document.addEventListener('DOMContentLoaded', function initWrapper() {
            // 延遲初始化以確保其他功能已載入
            setTimeout(() => {
                if (document.getElementById('accountList')) {
                    initAccountManagement();
                }
            }, 500);
        });
    }
}

// ===== 管理員區塊切換功能（合併新增/修改點位）=====
let currentAdminSection = 'point';

function switchAdminSection(section) {
    if (section !== 'hotspot') {
        closeInlineHotspotViewer();
    }

    currentAdminSection = section;

    // 隱藏所有內容區塊
    const pointContent = document.getElementById('pointModeContent');
    const hotspotContent = document.getElementById('hotspotModeContent');
    const imageContent = document.getElementById('imageModeContent');
    const settingsContent = document.getElementById('settingsModeContent');

    if (pointContent) pointContent.style.display = 'none';
    if (hotspotContent) hotspotContent.style.display = 'none';
    if (imageContent) imageContent.style.display = 'none';
    if (settingsContent) settingsContent.style.display = 'none';

    // 更新右側選單狀態
    document.querySelectorAll('.admin-menu-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === section);
    });

    // 顯示對應區塊
    if (section === 'point' && pointContent) {
        pointContent.style.display = 'flex';
    } else if (section === 'hotspot' && hotspotContent) {
        hotspotContent.style.display = 'flex';
        // 載入 360 圖片列表
        loadHotspotImageList();
    } else if (section === 'image' && imageContent) {
        imageContent.style.display = 'flex';
        if (typeof updateAdminMode === 'function') updateAdminMode('image');
        if (typeof loadUploadedImagesList === 'function') {
            setTimeout(() => loadUploadedImagesList(), 100);
        }
    } else if (section === 'settings' && settingsContent) {
        settingsContent.style.display = 'flex';
        if (typeof initAccountManagement === 'function') {
            setTimeout(() => initAccountManagement(), 100);
        }
    }
}

// 控管熱點詳細設定面板中欄位的顯示與隱藏（區分資訊型與導覽型）
function updateHotspotFormVisibility() {
    const type = document.getElementById('hotspotType')?.value || 'info';

    const imageContainer = document.getElementById('hotspotImageSelect')?.closest('.input-item');
    const sceneContainer = document.getElementById('hotspotScene')?.closest('.input-item');

    if (type === 'info') {
        if (imageContainer) imageContainer.style.display = 'block';
        if (sceneContainer) sceneContainer.style.display = 'none';
    } else if (type === 'scene') {
        if (imageContainer) imageContainer.style.display = 'none';
        if (sceneContainer) sceneContainer.style.display = 'block';
    } else {
        if (imageContainer) imageContainer.style.display = 'block';
        if (sceneContainer) sceneContainer.style.display = 'block';
    }
}

// 載入熱點管理的 360 圖片列表與欄位選項
async function loadHotspotImageList() {
    const select360 = document.getElementById('hotspot360ImageSelect');
    const selectScene = document.getElementById('hotspotScene');
    const selectImage = document.getElementById('hotspotImageSelect');

    try {
        const [imagesRes, metaRes] = await Promise.all([
            fetch(`${API_BASE}/api/get-uploaded-images`),
            fetch(`${API_BASE}/api/get-image-meta`)
        ]);
        if (!imagesRes.ok || !metaRes.ok) return;

        const images = await imagesRes.json();
        const meta = await metaRes.json();

        // 1. 填入 360 圖片編輯選擇器
        if (select360) {
            select360.innerHTML = '<option value="">-- 請選擇 360 全景圖片 --</option>';
        }
        // 2. 填入導覽目標場景選擇器
        if (selectScene) {
            selectScene.innerHTML = '<option value="">-- 選擇目標場景 --</option>';
        }
        // 3. 填入一般圖片選擇器
        if (selectImage) {
            selectImage.innerHTML = '';
        }

        if (Array.isArray(images)) {
            images.forEach(filename => {
                const data = meta?.[filename] || {};
                const is360 = data.type === '360' || getStoredImageType(filename) === '360' || /^360img-/i.test(filename);

                if (is360) {
                    if (select360) {
                        const option = document.createElement('option');
                        option.value = filename;
                        option.textContent = data.title || filename;
                        select360.appendChild(option);
                    }
                    if (selectScene) {
                        const option = document.createElement('option');
                        option.value = filename;
                        option.textContent = data.title || filename;
                        selectScene.appendChild(option);
                    }
                } else {
                    if (selectImage) {
                        const option = document.createElement('option');
                        option.value = filename;
                        option.textContent = data.title || filename;
                        selectImage.appendChild(option);
                    }
                }
            });
        }
        if (selectScene && selectScene.options.length <= 1 && Array.isArray(images)) {
            images.forEach(filename => {
                const data = meta?.[filename] || {};
                const option = document.createElement('option');
                option.value = filename;
                option.textContent = `${data.title || filename} (${filename})`;
                selectScene.appendChild(option);
            });
        }
    } catch (err) {
        console.warn('loadHotspotImageList failed:', err);
    }
}

// 綁定熱點圖片選擇事件（在 DOMContentLoaded 後執行）
document.addEventListener('DOMContentLoaded', function () {
    const hotspotImageSelect = document.getElementById('hotspot360ImageSelect');
    if (!hotspotImageSelect) return;

    hotspotImageSelect.addEventListener('change', function () {
        const selectedFile = this.value;
        console.log('Hotspot image selected:', selectedFile); // 除錯用

        if (!selectedFile) {
            // 隱藏熱點管理面板
            const managePanel = document.getElementById('hotspotManagePanel');
            const settingsPanel = document.getElementById('hotspotSettingsPanel');
            if (managePanel) managePanel.style.display = 'none';
            if (settingsPanel) settingsPanel.style.display = 'none';
            closeInlineHotspotViewer();
            // 清除當前編輯的檔案
            currentEditing360File = null;
            localStorage.removeItem('currentEditing360File');
            return;
        }

        // 左側顯示 360 全景（非滿版）
        openInlineHotspotViewer(selectedFile);

        // 顯示熱點管理面板
        const managePanel = document.getElementById('hotspotManagePanel');
        const settingsPanel = document.getElementById('hotspotSettingsPanel');

        if (managePanel) {
            managePanel.style.display = 'block';
            if (settingsPanel) settingsPanel.style.display = 'none';

            // 載入該圖片的熱點
            loadHotspotsFor360Image(selectedFile).then(hotspots => {
                console.log('Loaded hotspots:', hotspots); // 除錯用
                hotspotsEditorData = hotspots;
                currentEditing360File = selectedFile; // 確保設置當前編輯的檔案
                localStorage.setItem('currentEditing360File', selectedFile); // 保存到 localStorage
                console.log('Set currentEditing360File:', currentEditing360File); // 除錯用
                renderHotspotsList();
                updateHotspotCount();
                showToast(`✅ 已載入 ${hotspots.length} 個熱點`);
            }).catch(err => {
                console.error('Failed to load hotspots:', err);
                showToast('❌ 載入熱點失敗');
            });
        }
    });
});

// 在 DOMContentLoaded 中註冊側欄按鈕事件
document.addEventListener('DOMContentLoaded', function () {
    const menuBtns = document.querySelectorAll('.admin-menu-btn');
    menuBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            const mode = this.dataset.mode;
            if (mode) switchAdminSection(mode);
        });
    });

    // 預設顯示點位管理
    switchAdminSection('point');
});

// ===== 360 模式樓層按鈕功能（首頁）=====
// 綁定全景模式中的樓層按鈕事件
function initPanoFloorButtons() {
    const floorNav = document.getElementById('panoramaFloorNav');
    if (!floorNav) return;

    const buttons = floorNav.querySelectorAll('.pano-floor-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const floor = this.dataset.floor;

            // 更新按鈕狀態
            buttons.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            // 設定當前樓層（統一轉大寫避免大小寫問題）
            currentFloor = String(floor).toUpperCase();

            // 重新渲染地圖上的點位（過濾樓層）
            renderAllMarkers();

            // 更新全景小地圖
            renderPanoramaMiniMap(currentPanoramaPointId);

            showToast(`🏢 已切換至 ${floor} 樓`);
        });
    });
}

// 在 DOMContentLoaded 或全景開啟時初始化樓層按鈕
document.addEventListener('DOMContentLoaded', function () {
    initPanoFloorButtons();

    // 在 openPanoramaMode 被呼叫後重新初始化（確保按鈕綁定）
    const origOpenPano = window.openPanoramaMode;
    if (origOpenPano) {
        window.openPanoramaMode = function (imageUrl, currentPointId) {
            origOpenPano(imageUrl, currentPointId);
            setTimeout(initPanoFloorButtons, 500);
        };
    }
});


// 熱點浮動視窗
function showHotspotPopup(title, desc, image, hotspot = {}) {
    const imagesList = normalizeHotspotImages(Array.isArray(image) ? image : { image, images: hotspot.images, imageFiles: hotspot.imageFiles });
    const overlay = document.getElementById('panorama-overlay');
    const isOverlayVisible = overlay && getComputedStyle(overlay).display !== 'none';
    if (!isOverlayVisible) {
        const globalPopup = document.getElementById('global-map-popup') || (() => {
            const el = document.createElement('div');
            el.id = 'global-map-popup';
            el.className = 'global-popup-card';
            document.body.appendChild(el);
            return el;
        })();
        if (globalPopup && typeof injectPopupContent === 'function') {
            injectPopupContent(globalPopup, {
                ...hotspot,
                title: title || hotspot.title || hotspot.text || '說明',
                desc: desc || hotspot.content || hotspot.text || '',
                images: imagesList
            });
            globalPopup.classList.add('active');
            return;
        }
    }

    if (!overlay) return;
    let popup = document.getElementById('hotspot-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'hotspot-popup';
        popup.className = 'hotspot-popup-card';
        overlay.appendChild(popup);
    }
    let html = '<div class="hotspot-popup-header"><strong>' + title + '</strong><button class="hotspot-popup-close" onclick="this.parentElement.parentElement.classList.remove(\'active\')">×</button></div>';
    if (desc) html += '<div class="hotspot-popup-desc">' + desc + '</div>';
    if (imagesList.length > 0) {
        html += '<div class="hotspot-popup-images-container" style="display:flex; gap:8px; overflow-x:auto; padding:8px 0; max-height:220px;">';
        imagesList.forEach((img, index) => {
            html += '<div class="hotspot-popup-image" style="flex:0 0 auto; max-width:200px; display:flex; align-items:center;"><img src="' + resolvePanoUrl(img) + '" alt="' + title + '" data-index="' + index + '" style="width:100%; border-radius:6px; box-shadow:0 2px 8px rgba(0,0,0,0.15); cursor:zoom-in;" /></div>';
        });
        html += '</div>';
    }
    popup.innerHTML = html;
    popup.querySelectorAll('.hotspot-popup-image img').forEach(img => {
        img.addEventListener('click', () => showImageFullscreen(imagesList.map(resolvePanoUrl), Number(img.dataset.index) || 0, title || '圖片'));
    });
    popup.classList.add('active');
}
