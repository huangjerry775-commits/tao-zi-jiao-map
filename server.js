const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // 解決 Live Server 造成的 405 與跨網域拒絕問題

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 啟用跨網域(CORS)與 JSON 解析
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); 

// 讓前端可以直接透過網址讀取 uploads 資料夾裡的圖片
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 自動檢查並建立圖片儲存資料夾
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const MARKERS_FILE = path.join(__dirname, 'markers.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const HOTSPOTS_FILE = path.join(__dirname, 'hotspots.json');

// ===================================================
// 帳號管理初始化與工具函數
// ===================================================

// 初始化帳號檔案（第一次執行時建立預設帳號）
function initAccountsFile() {
    if (!fs.existsSync(ACCOUNTS_FILE)) {
        const defaultAccounts = [
            { id: 'tyk114', username: 'tyk114', password: 'tyk1142026', role: 'owner', canDelete: false },
            { id: 'editor01', username: 'editor01', password: 'editor01', role: 'editor', canDelete: true },
            { id: 'editor02', username: 'editor02', password: 'editor02', role: 'editor', canDelete: true }
        ];
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaultAccounts, null, 2), 'utf8');
    }
}

// 讀取所有帳號
function readAccounts() {
    try {
        if (!fs.existsSync(ACCOUNTS_FILE)) initAccountsFile();
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (err) {
        console.error('讀取帳號檔案失敗:', err);
        return [];
    }
}

// 寫入帳號
function writeAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

// 初始化帳號檔案
initAccountsFile();

// 初始化熱點檔案
function initHotspotsFile() {
    if (!fs.existsSync(HOTSPOTS_FILE)) {
        fs.writeFileSync(HOTSPOTS_FILE, JSON.stringify({}), 'utf8');
    }
}

// 讀取所有熱點
function readHotspots() {
    try {
        if (!fs.existsSync(HOTSPOTS_FILE)) initHotspotsFile();
        const data = fs.readFileSync(HOTSPOTS_FILE, 'utf8');
        return JSON.parse(data || '{}');
    } catch (err) {
        console.error('讀取熱點檔案失敗:', err);
        return {};
    }
}

// 寫入熱點
function writeHotspots(hotspots) {
    fs.writeFileSync(HOTSPOTS_FILE, JSON.stringify(hotspots, null, 2), 'utf8');
}

// 初始化熱點檔案
initHotspotsFile();

function sanitizeFileName(name) {
    return String(name || '')
        .trim()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9-_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'upload';
}

// ===================================================
// 2. 圖片上傳環境設定 (使用 multer)
// ===================================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // 防止檔名重複，加上時間戳記
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        // 限制只能上傳圖片格式
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('只能上傳圖片檔案！'), false);
        }
        cb(null, true);
    }
});

// ===================================================
// 帳號管理 API 路由
// ===================================================

// 取得所有帳號（不回傳密碼）
app.get('/api/accounts', (req, res) => {
    const accounts = readAccounts();
    // 過濾掉密碼欄位後回傳
    const safeAccounts = accounts.map(acc => ({
        id: acc.id,
        username: acc.username,
        role: acc.role,
        canDelete: acc.canDelete !== false // 預設可刪除
    }));
    res.json(safeAccounts);
});

// 新增帳號
app.post('/api/add-account', (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: '請輸入帳號和密碼' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: '密碼長度至少需要 6 個字元' });
    }

    const accounts = readAccounts();
    
    // 檢查帳號是否已存在
    if (accounts.some(acc => acc.username === username)) {
        return res.status(409).json({ success: false, message: '帳號已存在' });
    }

    const newAccount = {
        id: username,
        username: username,
        password: password,
        role: role || 'editor',
        canDelete: true
    };
    
    accounts.push(newAccount);
    writeAccounts(accounts);
    
    res.json({ success: true, message: '帳號已新增' });
});

// 刪除帳號
app.delete('/api/delete-account/:id', (req, res) => {
    const { id } = req.params;
    const accounts = readAccounts();
    
    const accountIndex = accounts.findIndex(acc => acc.id === id);
    if (accountIndex === -1) {
        return res.status(404).json({ success: false, message: '找不到該帳號' });
    }
    
    // 禁止刪除擁有者帳號
    if (accounts[accountIndex].role === 'owner') {
        return res.status(403).json({ success: false, message: '無法刪除最大系統管理員帳戶' });
    }
    
    accounts.splice(accountIndex, 1);
    writeAccounts(accounts);
    
    res.json({ success: true, message: '帳號已刪除' });
});

// 更改密碼
app.post('/api/change-password', (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '密碼長度至少需要 6 個字元' });
    }

    // 從 Authorization header 或預設修改第一個 owner 帳號的密碼
    // 由於目前無 session 機制，預設修改 tyk114 的密碼
    const accounts = readAccounts();
    const ownerAccount = accounts.find(acc => acc.id === 'tyk114');
    
    if (ownerAccount) {
        ownerAccount.password = newPassword;
        writeAccounts(accounts);
        res.json({ success: true, message: '密碼已更改' });
    } else {
        res.status(404).json({ success: false, message: '找不到管理員帳號' });
    }
});

// 登入驗證（支援多帳號）
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const accounts = readAccounts();
    
    const account = accounts.find(acc => acc.username === username && acc.password === password);
    
    if (account) {
        res.json({ 
            success: true, 
            token: 'staff-authenticated-token-2026',
            username: account.username,
            role: account.role
        });
    } else {
        res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
});

// ===================================================
// 3. 標點與地圖 API 路由
// ===================================================

// 讀取永久標點資料 API
app.get('/api/markers', (req, res) => {
    if (!fs.existsSync(MARKERS_FILE)) {
        fs.writeFileSync(MARKERS_FILE, JSON.stringify([])); // 若不存在則建立空陣列
    }
    res.json(JSON.parse(fs.readFileSync(MARKERS_FILE)));
});

// 儲存永久標點資料 API（新增點位用）
app.post('/api/markers/save', (req, res) => {
    try {
        fs.writeFileSync(MARKERS_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: '標點已永久儲存至 markers.json！' });
    } catch (err) {
        res.status(500).json({ success: false, message: '伺服器寫入失敗' });
    }
});

// 新增點位（另一種相容的寫法路徑，視前端對應而定）
app.post('/api/add-marker', (req, res) => {
    const newMarker = req.body;
    fs.readFile(MARKERS_FILE, 'utf8', (err, data) => {
        let markers = err ? [] : JSON.parse(data || '[]');
        markers.push(newMarker);
        fs.writeFile(MARKERS_FILE, JSON.stringify(markers, null, 2), 'utf8', (writeErr) => {
            if (writeErr) return res.status(500).json({ success: false, message: "寫入失敗" });
            res.json({ success: true, message: "點位新增成功" });
        });
    });
});

// 刪除指定點位的 API
app.delete('/api/delete-marker/:id', (req, res) => {
    const { id } = req.params;
    fs.readFile(MARKERS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ success: false, message: '找不到 markers.json' });
        const markers = JSON.parse(data || '[]');
        const next = markers.filter(m => m.id !== id);
        if (next.length === markers.length) {
            return res.status(404).json({ success: false, message: '找不到該點位' });
        }
        fs.writeFile(MARKERS_FILE, JSON.stringify(next, null, 2), 'utf8', (writeErr) => {
            if (writeErr) return res.status(500).json({ success: false, message: '寫入失敗' });
            res.json({ success: true, message: '點位刪除成功' });
        });
    });
});

// 修改/更新現有標點的 API
app.post('/api/update-marker', (req, res) => {
    const updatedMarker = req.body;
    
    fs.readFile(MARKERS_FILE, 'utf8', (err, data) => {
        let markers = err ? [] : JSON.parse(data || '[]');
        
        // 尋找舊的點位並覆蓋更新
        const index = markers.findIndex(m => m.id === updatedMarker.id);
        if (index !== -1) {
            markers[index] = updatedMarker;
            fs.writeFile(MARKERS_FILE, JSON.stringify(markers, null, 2), 'utf8', (writeErr) => {
                if (writeErr) return res.json({ success: false, message: "寫入失敗" });
                res.json({ success: true, message: "點位更新成功" });
            });
        } else {
            res.json({ success: false, message: "找不到該點位" });
        }
    });
});

// 自動讀取已上傳的所有全景圖片清單 API
app.get('/api/get-uploaded-images', (req, res) => {
    fs.readdir(uploadsDir, (err, files) => {
        if (err) return res.status(500).json([]);
        // 篩選出常見的圖片格式
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file));
        res.json(imageFiles);
    });
});

// 儲存圖片 metadata（與前端同步）
app.post('/api/save-image-meta', (req, res) => {
    try {
        const metaFile = path.join(__dirname, 'image_meta.json');
        const payload = req.body || {};
        const filename = payload.filename;
        const meta = payload.meta || {};
        if (!filename) return res.status(400).json({ success: false, message: '缺少 filename' });

        let store = {};
        if (fs.existsSync(metaFile)) {
            try { store = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}'); } catch(e) { store = {}; }
        }
        store[filename] = meta;
        fs.writeFileSync(metaFile, JSON.stringify(store, null, 2), 'utf8');
        res.json({ success: true, message: '圖片 metadata 已儲存' });
    } catch (err) {
        console.error('save-image-meta error', err);
        res.status(500).json({ success: false, message: '伺服器寫入失敗' });
    }
});

// 取得所有圖片 metadata
app.get('/api/get-image-meta', (req, res) => {
    try {
        const metaFile = path.join(__dirname, 'image_meta.json');
        if (!fs.existsSync(metaFile)) return res.json({});
        const data = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        res.json(data);
    } catch (err) {
        console.error('get-image-meta error', err);
        res.status(500).json({});
    }
});

// 處理獨立圖片上傳的 API 路由（含 sharp 自動壓縮）
app.post('/api/upload-image', upload.single('panoramaImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: '請選取一個檔案' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const requestedName = sanitizeFileName(req.body.customFileName || path.basename(req.file.originalname, ext));
    const finalName = `${requestedName}${ext}`;
    const finalPath = path.join(uploadsDir, finalName);
    const is360 = req.body.imageType === '360';

    // 圖片壓縮設定：360 圖片最大 4096px 寬、一般圖片最大 2048px 寬
    const maxDimension = is360 ? 4096 : 2048;
    const quality = is360 ? 80 : 82;

    try {
        if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
        }

        // 嘗試用 sharp 壓縮圖片；若失敗則直接搬移原檔
        try {
            const metadata = await sharp(req.file.path).metadata();
            const needsResize = (metadata.width > maxDimension || metadata.height > maxDimension);
            const needsJpeg = ext === '.jpg' || ext === '.jpeg';
            const needsWebp = ext === '.webp';

            if (needsResize || needsJpeg || needsWebp) {
                let pipeline = sharp(req.file.path);
                if (needsResize) {
                    pipeline = pipeline.resize({
                        width: maxDimension,
                        height: maxDimension,
                        fit: 'inside',
                        withoutEnlargement: true
                    });
                }
                // 輸出與原始相同的格式
                if (needsWebp) {
                    pipeline = pipeline.webp({ quality });
                } else if (needsJpeg || ext === '.jpg' || ext === '.jpeg') {
                    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
                } else if (ext === '.png') {
                    pipeline = pipeline.png({ compressionLevel: 8 });
                }
                await pipeline.toFile(finalPath);
                // 刪除 multer 暫存檔
                if (req.file.path !== finalPath && fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
            } else {
                // 不需處理，直接搬移
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                fs.renameSync(req.file.path, finalPath);
            }
        } catch (sharpErr) {
            console.warn('sharp 壓縮失敗，直接搬移原檔：', sharpErr.message);
            if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
            fs.renameSync(req.file.path, finalPath);
        }

        res.json({
            success: true,
            filename: finalName,
            imageType: req.body.imageType || 'normal',
            message: '圖片上傳成功！'
        });
    } catch (err) {
        console.error('重命名上傳圖片失敗：', err);
        return res.status(500).json({ success: false, message: '上傳後重命名失敗' });
    }
});

// 刪除指定圖片檔案 API
app.delete('/api/delete-image/:filename', (req, res) => {
    const fileName = decodeURIComponent(req.params.filename);
    const targetPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ success: false, message: '找不到該圖片檔案' });
    }
    fs.unlink(targetPath, (err) => {
        if (err) return res.status(500).json({ success: false, message: '刪除圖片失敗' });
        res.json({ success: true, message: '圖片刪除成功' });
    });
});

// 批次刪除圖片 API
app.post('/api/batch-delete-images', (req, res) => {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || filenames.length === 0) {
        return res.status(400).json({ success: false, message: '未提供檔案列表' });
    }
    let deleted = 0;
    let failed = 0;
    filenames.forEach(fname => {
        const targetPath = path.join(uploadsDir, fname);
        try {
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
                deleted++;
            } else {
                failed++;
            }
        } catch (e) {
            failed++;
        }
    });
    res.json({ success: true, deleted, failed, message: `已刪除 ${deleted} 張，失敗 ${failed} 張` });
});

// 批次更新圖片類型 API
app.post('/api/batch-update-image-type', (req, res) => {
    const { filenames, imageType } = req.body;
    if (!Array.isArray(filenames) || !imageType) {
        return res.status(400).json({ success: false, message: '缺少參數' });
    }
    const metaFile = path.join(__dirname, 'image_meta.json');
    let store = {};
    try {
        if (fs.existsSync(metaFile)) {
            store = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        }
    } catch (e) { store = {}; }
    
    let updated = 0;
    filenames.forEach(fname => {
        if (store[fname]) {
            store[fname].type = imageType;
            updated++;
        } else {
            store[fname] = { type: imageType };
            updated++;
        }
    });
    fs.writeFileSync(metaFile, JSON.stringify(store, null, 2), 'utf8');
    res.json({ success: true, updated, message: `已更新 ${updated} 張圖片類型為 ${imageType}` });
});

// ===================================================
// 5. 360 熱點管理 API
// ===================================================

// 取得指定 360 圖片的熱點
app.get('/api/hotspots/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const hotspots = readHotspots();
    
    // 統一 key 格式：先嘗試原始檔名，再嘗試清理前綴後的檔名
    const cleanFilename = filename.replace(/^360img-/, '');
    const imageHotspots = hotspots[filename] || hotspots[cleanFilename] || [];
    
    console.log('📖 讀取熱點:', filename, '-> 找到', imageHotspots.length, '個熱點');
    res.json(imageHotspots);
});

// 儲存 360 圖片的熱點
app.post('/api/hotspots/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const hotspotData = req.body;
    
    console.log('💾 儲存熱點:', filename);
    console.log('   熱點數量:', Array.isArray(hotspotData) ? hotspotData.length : 'N/A');
    console.log('   接收到的原始 Body:', JSON.stringify(req.body));
    
    if (!Array.isArray(hotspotData)) {
        return res.status(400).json({ success: false, message: '熱點資料格式錯誤' });
    }
    
    // Ensure each hotspot has required fields (title, content)
    const normalizedHotspots = hotspotData.map(spot => {
        if (typeof spot !== 'object' || spot === null) return spot;
        if (!('title' in spot)) spot.title = '';
        if (!('content' in spot)) spot.content = '';
        const imageSources = [
            ...(Array.isArray(spot.images) ? spot.images : []),
            ...(Array.isArray(spot.imageFiles) ? spot.imageFiles : []),
            ...(spot.image ? String(spot.image).split(',') : [])
        ];
        const seenImages = new Set();
        spot.images = imageSources
            .map(file => String(file || '').trim())
            .filter(file => {
                if (!file || seenImages.has(file)) return false;
                seenImages.add(file);
                return true;
            });
        spot.image = spot.images.join(',');
        return spot;
    });

    // 如果收到空陣列且預期有資料，記錄警告
    if (hotspotData.length === 0) {
        console.warn('   ⚠️ 警告：收到空熱點陣列');
    }
    
    const hotspots = readHotspots();
    
    // 統一 key 格式：使用純檔名（不含前綴）
    const cleanFilename = filename.replace(/^360img-/, '');
    hotspots[cleanFilename] = normalizedHotspots;
    
    // 清理舊的 key（如果存在帶前綴的版本）
    if (filename !== cleanFilename && hotspots[filename]) {
        delete hotspots[filename];
    }
    
    try {
        writeHotspots(hotspots);
        
        // 立即驗證寫入是否成功
        const verifyHotspots = readHotspots();
        const savedData = verifyHotspots[cleanFilename];
        
        if (savedData && Array.isArray(savedData) && savedData.length === normalizedHotspots.length) {
            console.log('   ✅ 寫入驗證成功，熱點數量:', savedData.length);
        } else {
            console.error('   ❌ 寫入驗證失敗！');
            console.error('   預期數量:', normalizedHotspots.length, '實際數量:', savedData ? savedData.length : 0);
        }
        
        console.log('   已儲存到 hotspots.json，key:', cleanFilename);
        res.json({ success: true, message: '熱點已儲存', data: normalizedHotspots });
    } catch (err) {
        console.error('   ❌ 寫入檔案失敗:', err);
        res.status(500).json({ success: false, message: '寫入檔案失敗: ' + err.message });
    }
});

// 刪除 360 圖片的熱點
app.delete('/api/hotspots/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const hotspots = readHotspots();
    
    if (hotspots[filename]) {
        delete hotspots[filename];
        writeHotspots(hotspots);
    }
    
    res.json({ success: true, message: '熱點已刪除' });
});

// 舊版上傳路徑相容（防止前端呼叫舊路由報錯）
app.post('/api/upload', upload.single('panoImage'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '未收到檔案' });
    res.json({ success: true, filePath: `./uploads/${req.file.filename}`, filename: req.file.filename });
});

// ===================================================
// 4. 啟動監聽
// ===================================================
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` 🚀 桃子腳地圖專案：後端系統已成功啟動！`);
    console.log(` 🔗 後端 API 網址：http://localhost:${PORT}`);
    console.log(` 💡 請保持此視窗開啟，並搭配您的 Live Server 進行測試。`);
    console.log(`===================================================`);
});
