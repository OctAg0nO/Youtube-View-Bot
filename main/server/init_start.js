import { Server } from "socket.io"
import express from "express"
import http from "http"
import session from "express-session"
import Database from "better-sqlite3"
import SQLite3Session from "better-sqlite3-session-store"
import { findChrome } from 'find-chrome-bin'
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 } from 'uuid';
import { NodeVM } from 'vm2';
import { existsSync, readFileSync, readdirSync } from "fs"

import { createRequire } from "module";
import { defaultServerInfo } from "./vars.js"

process.setMaxListeners(0)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const SqliteStore = SQLite3Session(session)
const db = new Database(path.join(__dirname, `../database.db3`))
const app = express();
let route = express.Router()

const server = http.createServer(app);
const io = new Server(server)

//app.set('trust proxy', 1)

function random(min, max){
    if(max){
        return min + Math.floor(Math.random() * (max - min))
    } else {
        if(typeof min == "object"){
            return min[random(min.length)]
        } else {
            return Math.floor(Math.random() * min)
        }
    }
}

function computeTime(time) {
    return new Date(time.getFullYear(), time.getMonth(), time.getDate(), time.getHours(), 0, 0)
}

function getCurrentTime() {
    return computeTime(new Date())
}

//db.pragma('journal_mode = WAL');

db.prepare("CREATE TABLE IF NOT EXISTS bandwidth (date INTEGER, value INTEGER, UNIQUE(date))").run()
db.prepare("CREATE TABLE IF NOT EXISTS views (date INTEGER, value INTEGER, UNIQUE(date))").run()
db.prepare("CREATE TABLE IF NOT EXISTS watch_time (date INTEGER, value INTEGER, UNIQUE(date))").run()

db.prepare("CREATE TABLE IF NOT EXISTS video_cache (data TEXT, id TEXT, UNIQUE(id))").run()
db.prepare("CREATE TABLE IF NOT EXISTS options (data TEXT, id INTEGER)").run()
db.prepare("CREATE TABLE IF NOT EXISTS cache (url TEXT, data TEXT, UNIQUE(url))").run()
db.prepare("CREATE TABLE IF NOT EXISTS secret (data TEXT)").run()

db.prepare("CREATE TABLE IF NOT EXISTS videos (data TEXT, id INTEGER, UNIQUE(id))").run()
db.prepare("CREATE TABLE IF NOT EXISTS good_proxies (data TEXT, id INTEGER, UNIQUE(id))").run()
db.prepare("CREATE TABLE IF NOT EXISTS proxies (data TEXT, id INTEGER, UNIQUE(id))").run()

db.prepare("CREATE TABLE IF NOT EXISTS srv_password (password TEXT, id INTEGER)").run()
db.prepare("CREATE TABLE IF NOT EXISTS keys (key TEXT, status INTEGER, UNIQUE(key))").run()



db.prepare('INSERT OR IGNORE INTO proxies (data, id) VALUES (?, 1)').run(`["direct://"]`)
db.prepare('INSERT OR IGNORE INTO good_proxies (data, id) VALUES (?, 1)').run(`[]`)
db.prepare('INSERT OR IGNORE INTO videos (data, id) VALUES (?, 1)').run(`[]`)

let workingStatus = 0
let proxyStats = {good: [], bad: [], untested: []} 
let stats = {}
let extensions = []

stats = {
    views: db.prepare(`SELECT * FROM views`).all(),
    watch_time: db.prepare(`SELECT * FROM watch_time`).all(),
    bandwidth: db.prepare(`SELECT * FROM bandwidth`).all(),
}

let good_proxies = JSON.parse(db.prepare(`SELECT * FROM good_proxies`).pluck().get())
let proxies = JSON.parse(db.prepare(`SELECT * FROM proxies`).pluck().get())
let videos = JSON.parse(db.prepare(`SELECT * FROM videos`).pluck().get())

let currentSecret = db.prepare(`SELECT * FROM secret`).pluck().get()
if (!currentSecret) {
    currentSecret = v4().split("-").join("")
    db.prepare('INSERT INTO secret (data) VALUES (?)').run(currentSecret)
}

let getChrome = () => {
    return new Promise((resolve) => {
        findChrome().then((chromePath) => {
            resolve(chromePath && chromePath.executablePath || "")
        }).catch((err) => {
            resolve("")
        })
    })
}

let settings = db.prepare(`SELECT * FROM options`).pluck().get()
global.worker_zombies = JSON.parse(readFileSync(path.join(__dirname, "../clients.json"), "utf-8"))
worker_zombies.current = []

if (!settings) {
    getChrome().then((chromePath) => {
        settings = {...defaultServerInfo, chromePath}
        global.settings = settings

        db.prepare('INSERT INTO options (data, id) VALUES (?, 1)').run(JSON.stringify(settings))
        server.listen(settings.server_port, () => process.stdout.write(`listening|${settings.server_port}`))
    })
} else {
    settings = JSON.parse(settings)
    server.listen(settings.server_port, () => process.stdout.write(`listening|${settings.server_port}`))
}

const sessionMiddleware = session({
    secret: currentSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        sameSite: true,
        maxAge: 2592000000 // one month in ms
    },
    store: new SqliteStore({
        client: db,
        expired: {
            clear: false,
            intervalMs: 900000,
        }
    })
})

let makeGlobal = {
    db, app, route, io,
    settings, workingStatus, good_proxies, proxyStats,
    workers: [], jobs: [], workers_finished: [], stats,
    server_password_global: undefined,
    server_version: readFileSync(path.join(__dirname, "../../VERSION"), "utf-8"),
    videos, proxies,
    __dirname, require,
    extensions,
    lastHealth: {},
    random,
    computeTime, getCurrentTime,
    sessionMiddleware,
}

for (let [key, value] of Object.entries(makeGlobal)){
    global[key] = value
}

for (let extensionPath of readdirSync(path.join(__dirname, "../../extensions"))){
    extensionPath = path.join(__dirname, "../../extensions", extensionPath)
    let extensioninfo = JSON.parse(readFileSync(path.join(extensionPath, "info.json")))
    let extensionVM = new NodeVM({
        sandbox: {
            getWorkingStatus: () => global.workingStatus,
            getProxies: () => global.proxies,
            getVideos: () => global.videos,
            transformProxies: (newProxies) => global.proxies = newProxies,
            transformProxies: (newProxies) => global.proxies = newProxies,
            transformStatus: (newStatus) => {global.workingStatus = newStatus; startWorking()},
            server_version, 
            computeTime, getCurrentTime,
        },
        require: {
            external: true,
            
        },
    })

    extensionVM.runFile(path.join(extensionPath, "main.js"))
    extensions.push({...extensioninfo, vm: extensionVM})
}

global.extensions = extensions