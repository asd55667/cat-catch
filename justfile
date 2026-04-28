# 构建脚本（crx）

# 设置默认shell为bash
set shell := ["bash", "-c"]

artifact := "cat-catch-custom"
# 签名私钥放在扩展目录外，避免加载 unpacked 扩展时被 Chrome 扫描到。
key_file := "../cat-catch-custom.pem"

# 默认任务：显示帮助
default:
    @just --list

# 安装依赖
install:
    npm install
    npm install -g crx3

# 清理构建目录
clean:
    rm -rf build dist web-ext-artifacts
    rm -f *.crx *.zip

# 删除本地扩展签名私钥（会导致下一次构建产生新的 Chromium 扩展 ID）
clean-key:
    rm -f {{key_file}}

# 验证manifest文件
validate:
    @echo "验证 manifest.json..."
    @node -e "const manifest = require('./manifest.json'); console.log('Extension name:', manifest.name); console.log('Version:', manifest.version); if (!manifest.manifest_version || !manifest.name || !manifest.version) { throw new Error('Invalid manifest.json'); }"

# 准备构建目录
prepare: validate generate-key
    @echo "准备构建目录..."
    mkdir -p build
    cp -r ./{catch-script,css,img,js,lib,_locales} build/
    cp -r ./*.html build/
    cp manifest.json build/
    @node -e 'const fs = require("fs"); const crypto = require("crypto"); const manifestPath = "build/manifest.json"; const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.key = crypto.createPublicKey(fs.readFileSync("{{key_file}}")).export({ type: "spki", format: "der" }).toString("base64"); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");'
    @echo "✅ 文件复制完成"

# 检查图标文件
check-icons:
    @echo "检查图标文件..."
    @if [ ! -d "img" ]; then echo "❌ img/ 目录不存在"; exit 1; fi
    @if [ ! -f "img/icon.png" ]; then echo "❌ 缺少图标: img/icon.png"; exit 1; fi
    @if [ ! -f "img/icon128.png" ]; then echo "❌ 缺少图标: img/icon128.png"; exit 1; fi
    @echo "✅ 所有图标文件存在"

# 生成私钥
generate-key:
    @echo "生成私钥..."
    @if [ ! -f "{{key_file}}" ]; then \
        openssl genrsa -out "{{key_file}}" 2048; \
        echo "✅ 私钥已生成"; \
    else \
        echo "✅ 私钥已存在"; \
    fi

# 显示当前本地 Chromium 扩展 ID
extension-id: generate-key
    @node -e 'const fs = require("fs"); const crypto = require("crypto"); const pub = crypto.createPublicKey(fs.readFileSync("{{key_file}}")).export({ type: "spki", format: "der" }); const hex = crypto.createHash("sha256").update(pub).digest("hex").slice(0, 32); const id = hex.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16))); console.log("Chromium extension ID:", id);'

# 构建ZIP文件
build-zip: prepare check-icons
    @echo "构建 ZIP 文件..."
    @cd build && \
        VERSION=$(node -p "require('./manifest.json').version") && \
        zip -r "../{{artifact}}${VERSION}.zip" . && \
        echo "✅ ZIP 文件已生成: {{artifact}}${VERSION}.zip"

# 构建CRX文件
build-crx: prepare check-icons generate-key
    @echo "构建 CRX 文件..."
    @VERSION=$(node -p "require('./manifest.json').version") && \
    crx3 -p "{{key_file}}" -o "{{artifact}}${VERSION}.crx" build/ && \
    echo "✅ CRX 文件已生成: {{artifact}}${VERSION}.crx"

# 快速构建（仅ZIP）
quick: build-zip
    @echo "🚀 快速构建完成！"

# 完整构建（CRX + ZIP）
build: build-crx build-zip
    @echo "🎉 构建完成！"
    @ls -la *.crx *.zip 2>/dev/null || true

# 开发模式 - 自动重载
dev-watch: prepare
    @echo "🔄 开发模式 - 自动构建"
    @echo "================================"
    @echo "监听文件变化并自动重新构建到 build/ 目录"
    @echo "请在Chrome中加载 build/ 目录，然后刷新扩展"
    @echo ""
    @if command -v inotifywait >/dev/null 2>&1; then \
        while true; do \
            inotifywait -r -e modify,create,delete src/ && \
            echo "🔄 检测到文件变化，重新构建..." && \
            just prepare; \
        done \
    else \
        echo "❌ 需要安装 inotify-tools: sudo apt install inotify-tools"; \
    fi

# 检查扩展
lint:
    @echo "检查扩展..."
    @echo "验证 manifest.json 格式..."
    @node -e "const manifest = require('./manifest.json'); console.log('✅ Manifest 格式正确'); console.log('扩展名:', manifest.name); console.log('版本:', manifest.version);"
    @echo "检查必需文件..."
    @if [ -f "popup.html" ]; then echo "✅ popup.html 存在"; else echo "❌ popup.html 缺失"; fi
    @if [ -f "options.html" ]; then echo "✅ options.html 存在"; else echo "❌ options.html 缺失"; fi
    @if [ -f "js/background.js" ]; then echo "✅ background.js 存在"; else echo "❌ background.js 缺失"; fi
    @if [ -f "js/content-script.js" ]; then echo "✅ content.js 存在"; else echo "❌ content.js 缺失"; fi
    @if [ -f "js/popup.js" ]; then echo "✅ popup.js 存在"; else echo "❌ popup.js 缺失"; fi
    @if [ -f "js/options.js" ]; then echo "✅ options.js 存在"; else echo "❌ options.js 缺失"; fi
    @echo "✅ Chrome扩展检查完成"

# 显示版本信息
version:
    @node -p "'当前版本: ' + require('./manifest.json').version"

# 显示项目状态
status:
    @echo "📊 项目状态："
    @node -p "'版本: ' + require('./manifest.json').version"
    @echo "图标状态:"
    @if [ -f "img/icon.png" ]; then echo "  ✅ img/icon.png"; else echo "  ❌ img/icon.png"; fi
    @if [ -f "img/icon128.png" ]; then echo "  ✅ img/icon128.png"; else echo "  ❌ img/icon128.png"; fi
    @echo "构建文件:"
    @ls -la *.crx *.zip 2>/dev/null || echo "  无构建文件"

# 完整的发布流程
release: clean install validate build
    @echo "🎉 发布包已准备完成！"
    @echo "文件列表："
    @ls -la *.crx *.zip
