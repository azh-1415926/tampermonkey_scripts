// ============================================================
//  WTB Pusher —— 网页工具箱子模块推送工具
//
//  启动后在本地监听一个 HTTP 端口，把模块定义（含完整 JS 代码）
//  以 JSON 形式暴露给浏览器端耦合层脚本。
//
//  协议：
//    GET /wtb/sync   -> { ok, revision, time, modules: [ {...}, ... ] }
//    GET /wtb/ping   -> { ok: true, server, version }
// ============================================================
#include <QApplication>
#include <QMainWindow>
#include <QWidget>
#include <QTcpServer>
#include <QTcpSocket>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QCryptographicHash>
#include <QListWidget>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QSpinBox>
#include <QCheckBox>
#include <QPushButton>
#include <QLabel>
#include <QSplitter>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QGroupBox>
#include <QMessageBox>
#include <QFileDialog>
#include <QMenuBar>
#include <QMenu>
#include <QAction>
#include <QStatusBar>
#include <QStandardPaths>
#include <QDir>
#include <QFile>
#include <QUrl>
#include <QDateTime>
#include <QSharedPointer>
#include <QFontDatabase>
#include <QSignalBlocker>
#include <functional>

// ============================================================
//  数据模型
// ============================================================
struct ModuleDef
{
    QString id;
    QString title;
    QString icon;
    int     order   = 100;
    QString version;
    QString code;
    bool    enabled = true;

    QString hash() const
    {
        const QString src = id      + QChar(0x1f) + title   + QChar(0x1f) +
                            icon    + QChar(0x1f) + QString::number(order) + QChar(0x1f) +
                            version + QChar(0x1f) + code;
        return QString::fromLatin1(
            QCryptographicHash::hash(src.toUtf8(), QCryptographicHash::Sha1).toHex());
    }

    QJsonObject toJson() const
    {
        QJsonObject o;
        o["id"]      = id;
        o["title"]   = title;
        o["icon"]    = icon;
        o["order"]   = order;
        o["version"] = version;
        o["enabled"] = enabled;
        o["hash"]    = hash();
        o["code"]    = code;
        return o;
    }

    static ModuleDef fromJson(const QJsonObject &o)
    {
        ModuleDef m;
        m.id      = o.value("id").toString();
        m.title   = o.value("title").toString();
        m.icon    = o.value("icon").toString();
        m.order   = o.value("order").toInt(100);
        m.version = o.value("version").toString("1.0.0");
        m.code    = o.value("code").toString();
        m.enabled = o.value("enabled").toBool(true);
        return m;
    }
};

// ============================================================
//  极简 HTTP 服务
// ============================================================
class WtbServer : public QTcpServer
{
    Q_OBJECT
public:
    using PayloadFn = std::function<QByteArray(const QString &path)>;

    explicit WtbServer(QObject *parent = nullptr) : QTcpServer(parent) {}

    void setPayloadProvider(PayloadFn fn) { m_payload = std::move(fn); }

protected:
    void incomingConnection(qintptr sd) override
    {
        auto *sock = new QTcpSocket(this);
        if (!sock->setSocketDescriptor(sd)) { sock->deleteLater(); return; }

        auto buf  = QSharedPointer<QByteArray>::create();
        auto done = QSharedPointer<bool>::create(false);

        connect(sock, &QTcpSocket::readyRead, this,
                [this, sock, buf, done]() {
            if (*done) return;
            buf->append(sock->readAll());

            const int idx = buf->indexOf("\r\n\r\n");
            if (idx < 0) {
                if (buf->size() > 64 * 1024) sock->abort();  // 防御性上限
                return;
            }
            *done = true;

            const QString head = QString::fromLatin1(buf->left(idx));
            const QStringList lines = head.split("\r\n");
            if (lines.isEmpty()) { sock->abort(); return; }

            const QStringList parts = lines.first().split(' ');
            if (parts.size() < 2) { sock->abort(); return; }

            const QString method = parts.at(0);
            const QString target = parts.at(1);

            // 只取 path（剥掉 query）
            const QString path = QUrl(QStringLiteral("http://x") + target).path();

            QByteArray body;
            int status = 200;

            if (method != QLatin1String("GET")) {
                status = 405;
                body = R"({"ok":false,"error":"method not allowed"})";
            } else if (path == QLatin1String("/wtb/sync") ||
                       path == QLatin1String("/wtb/ping")) {
                body = m_payload ? m_payload(path)
                                 : QByteArray(R"({"ok":false,"error":"no provider"})");
            } else {
                status = 404;
                body = R"({"ok":false,"error":"not found"})";
            }

            sendResponse(sock, status, body);
        });

        connect(sock, &QTcpSocket::disconnected, sock, &QObject::deleteLater);
    }

private:
    static QByteArray statusText(int code)
    {
        switch (code) {
        case 200: return "OK";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        default:  return "Error";
        }
    }

    static void sendResponse(QTcpSocket *sock, int status, const QByteArray &body)
    {
        QByteArray resp;
        resp += "HTTP/1.1 " + QByteArray::number(status) + " " + statusText(status) + "\r\n";
        resp += "Content-Type: application/json; charset=utf-8\r\n";
        resp += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
        resp += "Access-Control-Allow-Origin: *\r\n";
        resp += "Cache-Control: no-store, no-cache, must-revalidate\r\n";
        resp += "Connection: close\r\n\r\n";
        resp += body;

        sock->write(resp);
        sock->flush();
        sock->disconnectFromHost();
    }

    PayloadFn m_payload;
};

// ============================================================
//  主窗口
// ============================================================
class MainWindow : public QMainWindow
{
    Q_OBJECT
public:
    explicit MainWindow(QWidget *parent = nullptr);
    ~MainWindow() override;

private slots:
    void startServer();
    void stopServer();
    void onListSelectionChanged(int row);
    void onNewModule();
    void onDeleteModule();
    void onImport();
    void onExport();

private:
    void buildUi();
    void buildMenu();
    void loadModulesFromDisk();
    void saveModulesToDisk();
    QString dataFilePath() const;
    void refreshList();
    void fillEditor(int index);
    void commitEditor();
    void markChanged();
    QByteArray buildSyncJson() const;
    QByteArray handlePayload(const QString &path) const;
    void updateStatus();

    // ---- UI ----
    QListWidget    *m_list        = nullptr;
    QLineEdit      *m_edId        = nullptr;
    QLineEdit      *m_edTitle     = nullptr;
    QLineEdit      *m_edIcon      = nullptr;
    QLineEdit      *m_edVersion   = nullptr;
    QSpinBox       *m_spOrder     = nullptr;
    QCheckBox      *m_ckEnabled   = nullptr;
    QPlainTextEdit *m_edCode      = nullptr;
    QSpinBox       *m_spPort      = nullptr;
    QPushButton    *m_btnStart    = nullptr;
    QPushButton    *m_btnStop     = nullptr;
    QLabel         *m_lbStatus    = nullptr;
    QLabel         *m_lbCount     = nullptr;

    // ---- 数据 ----
    WtbServer           *m_server  = nullptr;
    QVector<ModuleDef>   m_modules;
    int                  m_current = -1;
    bool                 m_loading = false;   // 填充编辑器时抑制写回
    int                  m_revision = 1;
};

// ------------------------------------------------------------
MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent)
{
    buildUi();
    buildMenu();

    m_server = new WtbServer(this);
    m_server->setPayloadProvider([this](const QString &p) { return handlePayload(p); });

    loadModulesFromDisk();
    refreshList();

    if (!m_modules.isEmpty()) {
        m_list->setCurrentRow(0);
    }

    // 自动启动
    startServer();

    statusBar()->showMessage("就绪");
}

MainWindow::~MainWindow() = default;

// ------------------------------------------------------------
void MainWindow::buildUi()
{
    setWindowTitle(QStringLiteral("WTB 子模块推送工具"));
    resize(1120, 740);

    auto *central = new QWidget(this);
    setCentralWidget(central);

    // ---------- 顶部：服务控制 ----------
    m_spPort = new QSpinBox;
    m_spPort->setRange(1024, 65535);
    m_spPort->setValue(7531);
    m_spPort->setFixedWidth(90);

    m_btnStart = new QPushButton(QStringLiteral("启动服务"));
    m_btnStop  = new QPushButton(QStringLiteral("停止"));
    m_btnStop->setEnabled(false);

    m_lbStatus = new QLabel(QStringLiteral("● 未启动"));
    m_lbStatus->setStyleSheet("color:#c0392b; font-weight:600;");

    m_lbCount = new QLabel(QStringLiteral("模块：0"));

    auto *topBar = new QHBoxLayout;
    topBar->addWidget(new QLabel(QStringLiteral("监听端口：")));
    topBar->addWidget(m_spPort);
    topBar->addSpacing(6);
    topBar->addWidget(m_btnStart);
    topBar->addWidget(m_btnStop);
    topBar->addSpacing(20);
    topBar->addWidget(m_lbStatus);
    topBar->addSpacing(20);
    topBar->addWidget(m_lbCount);
    topBar->addStretch();

    // ---------- 左侧：模块列表 ----------
    m_list = new QListWidget;
    m_list->setMinimumWidth(240);

    auto *btnNew    = new QPushButton(QStringLiteral("新建"));
    auto *btnDel    = new QPushButton(QStringLiteral("删除"));
    auto *btnImport = new QPushButton(QStringLiteral("导入"));
    auto *btnExport = new QPushButton(QStringLiteral("导出"));

    auto *leftBtns = new QHBoxLayout;
    leftBtns->addWidget(btnNew);
    leftBtns->addWidget(btnDel);
    leftBtns->addWidget(btnImport);
    leftBtns->addWidget(btnExport);

    auto *leftPane   = new QWidget;
    auto *leftLayout = new QVBoxLayout(leftPane);
    leftLayout->setContentsMargins(0, 0, 0, 0);
    leftLayout->addWidget(new QLabel(QStringLiteral("模块列表")));
    leftLayout->addWidget(m_list, 1);
    leftLayout->addLayout(leftBtns);

    // ---------- 右侧：编辑器 ----------
    m_edId      = new QLineEdit;
    m_edTitle   = new QLineEdit;
    m_edIcon    = new QLineEdit;
    m_edIcon->setPlaceholderText(QStringLiteral("例如 🧪 或 emoji"));
    m_edVersion = new QLineEdit(QStringLiteral("1.0.0"));

    m_spOrder = new QSpinBox;
    m_spOrder->setRange(0, 9999);
    m_spOrder->setValue(100);

    m_ckEnabled = new QCheckBox(QStringLiteral("启用"));
    m_ckEnabled->setChecked(true);

    auto *form = new QFormLayout;
    form->addRow(QStringLiteral("模块 ID"), m_edId);
    form->addRow(QStringLiteral("标题"),    m_edTitle);
    form->addRow(QStringLiteral("图标"),    m_edIcon);
    form->addRow(QStringLiteral("版本"),    m_edVersion);

    auto *rowOrder = new QHBoxLayout;
    rowOrder->addWidget(new QLabel(QStringLiteral("排序")));
    rowOrder->addWidget(m_spOrder);
    rowOrder->addSpacing(20);
    rowOrder->addWidget(m_ckEnabled);
    rowOrder->addStretch();
    form->addRow(QString(), rowOrder);

    m_edCode = new QPlainTextEdit;
    m_edCode->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    m_edCode->setTabStopDistance(4 * QFontMetricsF(m_edCode->font()).horizontalAdvance(' '));
    m_edCode->setPlaceholderText(QStringLiteral(
        "// 可用参数：bus, unsafeWindow, document, module\n"
        "// 例如：bus.registerModule({ id:'x', title:'X', mount(ctx){ ... } })"));
    m_edCode->setLineWrapMode(QPlainTextEdit::NoWrap);

    auto *rightPane   = new QWidget;
    auto *rightLayout = new QVBoxLayout(rightPane);
    rightLayout->setContentsMargins(0, 0, 0, 0);
    rightLayout->addLayout(form);
    rightLayout->addWidget(new QLabel(QStringLiteral("模块代码")));
    rightLayout->addWidget(m_edCode, 1);

    // ---------- 分栏 ----------
    auto *splitter = new QSplitter(Qt::Horizontal);
    splitter->addWidget(leftPane);
    splitter->addWidget(rightPane);
    splitter->setStretchFactor(0, 0);
    splitter->setStretchFactor(1, 1);
    splitter->setSizes({ 280, 820 });

    auto *mainLayout = new QVBoxLayout(central);
    mainLayout->addLayout(topBar);
    mainLayout->addWidget(splitter, 1);

    // ---------- 连接 ----------
    connect(m_btnStart, &QPushButton::clicked, this, &MainWindow::startServer);
    connect(m_btnStop,  &QPushButton::clicked, this, &MainWindow::stopServer);
    connect(m_list, &QListWidget::currentRowChanged, this, &MainWindow::onListSelectionChanged);
    connect(btnNew,    &QPushButton::clicked, this, &MainWindow::onNewModule);
    connect(btnDel,    &QPushButton::clicked, this, &MainWindow::onDeleteModule);
    connect(btnImport, &QPushButton::clicked, this, &MainWindow::onImport);
    connect(btnExport, &QPushButton::clicked, this, &MainWindow::onExport);

    // 编辑器改动即时写回（配合 QSignalBlocker 避免填充时误触发）
    auto onChange = [this]() { commitEditor(); };
    connect(m_edId,      &QLineEdit::textChanged, this, onChange);
    connect(m_edTitle,   &QLineEdit::textChanged, this, onChange);
    connect(m_edIcon,    &QLineEdit::textChanged, this, onChange);
    connect(m_edVersion, &QLineEdit::textChanged, this, onChange);
    connect(m_spOrder,   QOverload<int>::of(&QSpinBox::valueChanged), this, onChange);
    connect(m_ckEnabled, &QCheckBox::toggled, this, onChange);
    connect(m_edCode,    &QPlainTextEdit::textChanged, this, onChange);
}

// ------------------------------------------------------------
void MainWindow::buildMenu()
{
    auto *fileMenu = menuBar()->addMenu(QStringLiteral("文件"));

    auto *actImport = fileMenu->addAction(QStringLiteral("导入模块 JSON…"));
    connect(actImport, &QAction::triggered, this, &MainWindow::onImport);

    auto *actExport = fileMenu->addAction(QStringLiteral("导出模块 JSON…"));
    connect(actExport, &QAction::triggered, this, &MainWindow::onExport);

    fileMenu->addSeparator();
    auto *actQuit = fileMenu->addAction(QStringLiteral("退出"));
    connect(actQuit, &QAction::triggered, this, &QWidget::close);

    auto *helpMenu = menuBar()->addMenu(QStringLiteral("帮助"));
    auto *actAbout = helpMenu->addAction(QStringLiteral("关于"));
    connect(actAbout, &QAction::triggered, this, [this]() {
        QMessageBox::information(this, QStringLiteral("关于"),
            QStringLiteral(
                "WTB 子模块推送工具\n\n"
                "在本地启动 HTTP 服务，向浏览器端耦合层提供模块定义。\n\n"
                "接口：\n"
                "  GET /wtb/sync\n"
                "  GET /wtb/ping\n\n"
                "浏览器端脚本每 2.5 秒轮询一次 /wtb/sync，\n"
                "根据 hash 差量热插拔模块。"));
    });
}

// ------------------------------------------------------------
void MainWindow::startServer()
{
    if (m_server->isListening()) return;

    const quint16 port = static_cast<quint16>(m_spPort->value());
    if (!m_server->listen(QHostAddress::LocalHost, port)) {
        QMessageBox::warning(this, QStringLiteral("启动失败"),
            QStringLiteral("无法监听 127.0.0.1:%1\n\n%2")
                .arg(port).arg(m_server->errorString()));
        return;
    }

    m_btnStart->setEnabled(false);
    m_btnStop->setEnabled(true);
    m_spPort->setEnabled(false);
    updateStatus();
    statusBar()->showMessage(QStringLiteral("服务已启动，监听 127.0.0.1:%1").arg(port), 5000);
}

// ------------------------------------------------------------
void MainWindow::stopServer()
{
    if (!m_server->isListening()) return;
    m_server->close();

    m_btnStart->setEnabled(true);
    m_btnStop->setEnabled(false);
    m_spPort->setEnabled(true);
    updateStatus();
    statusBar()->showMessage(QStringLiteral("服务已停止"), 5000);
}

// ------------------------------------------------------------
void MainWindow::updateStatus()
{
    if (m_server->isListening()) {
        m_lbStatus->setText(QStringLiteral("● 运行中  127.0.0.1:%1").arg(m_server->serverPort()));
        m_lbStatus->setStyleSheet("color:#16a34a; font-weight:600;");
    } else {
        m_lbStatus->setText(QStringLiteral("● 未启动"));
        m_lbStatus->setStyleSheet("color:#c0392b; font-weight:600;");
    }
    m_lbCount->setText(QStringLiteral("模块：%1").arg(m_modules.size()));
}

// ------------------------------------------------------------
void MainWindow::onListSelectionChanged(int row)
{
    if (m_current == row) return;
    m_current = row;
    fillEditor(row);
}

// ------------------------------------------------------------
void MainWindow::fillEditor(int index)
{
    m_loading = true;

    const bool valid = (index >= 0 && index < m_modules.size());
    const ModuleDef &m = valid ? m_modules.at(index) : ModuleDef();

    m_edId->setText(m.id);
    m_edTitle->setText(m.title);
    m_edIcon->setText(m.icon);
    m_edVersion->setText(m.version);
    m_spOrder->setValue(m.order);
    m_ckEnabled->setChecked(m.enabled);
    m_edCode->setPlainText(m.code);

    m_edId->setEnabled(valid);
    m_edTitle->setEnabled(valid);
    m_edIcon->setEnabled(valid);
    m_edVersion->setEnabled(valid);
    m_spOrder->setEnabled(valid);
    m_ckEnabled->setEnabled(valid);
    m_edCode->setEnabled(valid);

    m_loading = false;
}

// ------------------------------------------------------------
void MainWindow::commitEditor()
{
    if (m_loading) return;
    if (m_current < 0 || m_current >= m_modules.size()) return;

    ModuleDef &m = m_modules[m_current];
    m.id      = m_edId->text().trimmed();
    m.title   = m_edTitle->text();
    m.icon    = m_edIcon->text();
    m.version = m_edVersion->text();
    m.order   = m_spOrder->value();
    m.enabled = m_ckEnabled->isChecked();
    m.code    = m_edCode->toPlainText();

    // 同步列表显示
    if (QListWidgetItem *item = m_list->item(m_current)) {
        const QString label = (m.icon.isEmpty() ? QString() : m.icon + " ") +
                              (m.title.isEmpty() ? m.id : m.title);
        const QSignalBlocker blocker(m_list);
        item->setText(label);
    }

    markChanged();
}

// ------------------------------------------------------------
void MainWindow::markChanged()
{
    ++m_revision;
    saveModulesToDisk();
    updateStatus();
}

// ------------------------------------------------------------
void MainWindow::onNewModule()
{
    ModuleDef m;
    m.id      = QStringLiteral("module_%1").arg(m_modules.size() + 1);
    m.title   = QStringLiteral("新模块");
    m.icon    = QStringLiteral("🧩");
    m.version = QStringLiteral("1.0.0");
    m.order   = 100;
    m.code    = QStringLiteral(
        "bus.registerModule({\n"
        "  id: '%1',\n"
        "  title: '%2',\n"
        "  icon: '🧩',\n"
        "  order: 100,\n"
        "  mount(ctx) {\n"
        "    const { h, pane } = ctx;\n"
        "    pane.appendChild(h('div', { class: 'wtb-sec' }, [\n"
        "      h('div', { class: 'wtb-sec-title' }, '新模块'),\n"
        "      h('div', { class: 'wtb-hint' }, '在这里编写你的界面。')\n"
        "    ]));\n"
        "  }\n"
        "});\n").arg(m.id, m.title);

    m_modules.append(m);
    refreshList();
    m_list->setCurrentRow(m_modules.size() - 1);
    markChanged();
}

// ------------------------------------------------------------
void MainWindow::onDeleteModule()
{
    if (m_current < 0 || m_current >= m_modules.size()) return;

    const QString name = m_modules.at(m_current).id;
    if (QMessageBox::question(this, QStringLiteral("确认删除"),
            QStringLiteral("确定要删除模块「%1」吗？\n浏览器端会在下一轮同步时自动卸载它。").arg(name))
        != QMessageBox::Yes) {
        return;
    }

    m_modules.removeAt(m_current);
    refreshList();

    const int next = qMin(m_current, m_modules.size() - 1);
    m_current = -1;
    m_list->setCurrentRow(next);
    if (next < 0) fillEditor(-1);

    markChanged();
}

// ------------------------------------------------------------
void MainWindow::onImport()
{
    const QString path = QFileDialog::getOpenFileName(
        this, QStringLiteral("导入模块 JSON"), QString(), QStringLiteral("JSON (*.json)"));
    if (path.isEmpty()) return;

    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        QMessageBox::warning(this, QStringLiteral("读取失败"), f.errorString());
        return;
    }

    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
    if (err.error != QJsonParseError::NoError) {
        QMessageBox::warning(this, QStringLiteral("解析失败"), err.errorString());
        return;
    }

    QJsonArray arr;
    if (doc.isArray())              arr = doc.array();
    else if (doc.isObject())        arr = doc.object().value("modules").toArray();

    if (arr.isEmpty()) {
        QMessageBox::information(this, QStringLiteral("提示"), QStringLiteral("文件中没有找到模块。"));
        return;
    }

    int added = 0;
    for (const QJsonValue &v : std::as_const(arr)) {
        if (!v.isObject()) continue;
        ModuleDef m = ModuleDef::fromJson(v.toObject());
        if (m.id.isEmpty()) continue;

        // 同 ID 覆盖
        bool replaced = false;
        for (ModuleDef &existing : m_modules) {
            if (existing.id == m.id) { existing = m; replaced = true; break; }
        }
        if (!replaced) m_modules.append(m);
        ++added;
    }

    refreshList();
    markChanged();
    QMessageBox::information(this, QStringLiteral("导入完成"),
        QStringLiteral("已导入 %1 个模块。").arg(added));
}

// ------------------------------------------------------------
void MainWindow::onExport()
{
    const QString path = QFileDialog::getSaveFileName(
        this, QStringLiteral("导出模块 JSON"), QStringLiteral("wtb-modules.json"),
        QStringLiteral("JSON (*.json)"));
    if (path.isEmpty()) return;

    QJsonArray arr;
    for (const ModuleDef &m : std::as_const(m_modules)) arr.append(m.toJson());

    QJsonObject root;
    root["version"]  = 1;
    root["exported"] = QDateTime::currentDateTime().toString(Qt::ISODate);
    root["modules"]  = arr;

    QFile f(path);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        QMessageBox::warning(this, QStringLiteral("写入失败"), f.errorString());
        return;
    }
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    f.close();

    statusBar()->showMessage(QStringLiteral("已导出到 %1").arg(path), 5000);
}

// ------------------------------------------------------------
void MainWindow::refreshList()
{
    const QSignalBlocker blocker(m_list);
    m_list->clear();

    for (const ModuleDef &m : std::as_const(m_modules)) {
        const QString label = (m.icon.isEmpty() ? QString() : m.icon + " ") +
                              (m.title.isEmpty() ? m.id : m.title);
        auto *item = new QListWidgetItem(label);
        item->setToolTip(QStringLiteral("id: %1\nversion: %2\norder: %3\nhash: %4")
                             .arg(m.id, m.version)
                             .arg(m.order)
                             .arg(m.hash().left(12)));
        if (!m.enabled) item->setForeground(QColor(150, 150, 150));
        m_list->addItem(item);
    }

    updateStatus();
}

// ------------------------------------------------------------
QString MainWindow::dataFilePath() const
{
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(dir);
    return dir + QStringLiteral("/modules.json");
}

// ------------------------------------------------------------
void MainWindow::loadModulesFromDisk()
{
    QFile f(dataFilePath());
    if (!f.open(QIODevice::ReadOnly)) return;

    const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
    f.close();

    QJsonArray arr;
    if (doc.isObject()) arr = doc.object().value("modules").toArray();
    else if (doc.isArray()) arr = doc.array();

    for (const QJsonValue &v : std::as_const(arr)) {
        if (!v.isObject()) continue;
        ModuleDef m = ModuleDef::fromJson(v.toObject());
        if (!m.id.isEmpty()) m_modules.append(m);
    }
}

// ------------------------------------------------------------
void MainWindow::saveModulesToDisk()
{
    QJsonArray arr;
    for (const ModuleDef &m : std::as_const(m_modules)) arr.append(m.toJson());

    QJsonObject root;
    root["version"] = 1;
    root["saved"]   = QDateTime::currentDateTime().toString(Qt::ISODate);
    root["modules"] = arr;

    QFile f(dataFilePath());
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return;
    f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    f.close();
}

// ------------------------------------------------------------
QByteArray MainWindow::buildSyncJson() const
{
    QJsonArray arr;
    for (const ModuleDef &m : std::as_const(m_modules)) arr.append(m.toJson());

    QJsonObject root;
    root["ok"]       = true;
    root["server"]   = QStringLiteral("wtb-pusher/1.0");
    root["revision"] = m_revision;
    root["time"]     = QDateTime::currentDateTime().toString(Qt::ISODate);
    root["count"]    = arr.size();
    root["modules"]  = arr;

    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

// ------------------------------------------------------------
QByteArray MainWindow::handlePayload(const QString &path) const
{
    if (path == QLatin1String("/wtb/ping")) {
        QJsonObject o;
        o["ok"]      = true;
        o["server"]  = QStringLiteral("wtb-pusher/1.0");
        o["revision"] = m_revision;
        o["modules"] = m_modules.size();
        return QJsonDocument(o).toJson(QJsonDocument::Compact);
    }

    // /wtb/sync
    return buildSyncJson();
}

// ============================================================
int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QApplication::setApplicationName("wtb-pusher");
    QApplication::setOrganizationName("wtb");

    MainWindow w;
    w.show();

    return app.exec();
}

#include "main.moc"
