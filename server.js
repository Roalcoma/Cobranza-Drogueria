require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const path = require('path');
const session = require('express-session');
const winston = require('winston');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
let runSP = false;

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'app.log'), maxsize: 5242880, maxFiles: 3 })
    ]
});

const ICG_KEY = [78,79,82,77,65,76,75,69,89,78,79,82,77,65,76,75,69,89,78,79,82,77,65,76,75,69,89,78,79,82,77,65,76,75,69,89,78];
function icgEncriptar(text) {
    let r = '';
    for (let i = 0; i < text.length; i++) r += (text.charCodeAt(i) + ICG_KEY[i % ICG_KEY.length]).toString(16).toUpperCase();
    return r;
}

const baseDbConfig = {
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, options: { encrypt: true, trustServerCertificate: true }
};

const generalPool = new sql.ConnectionPool({ ...baseDbConfig, database: 'General' })
    .connect().then(p => { logger.info('Conectado a General'); return p; })
    .catch(e => { logger.error(`General: ${e.message}`); process.exit(1); });

const dbPools = new Map();
async function getDbPool(db) {
    if (dbPools.has(db)) return dbPools.get(db);
    const p = await new sql.ConnectionPool({ ...baseDbConfig, database: db }).connect();
    dbPools.set(db, p); logger.info(`Pool: ${db}`); return p;
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'fallback', resave: false, saveUninitialized: false, cookie: { maxAge: 8*3600000 } }));

function requireAuth(req, res, next) {
    if (req.session?.user?.empresa) return next();
    if (req.session?.user) return req.path.startsWith('/api/') ? res.status(403).json({ error: 'Seleccione empresa' }) : res.redirect('/empresa');
    return req.path.startsWith('/api/') ? res.status(401).json({ error: 'No autorizado' }) : res.redirect('/login');
}
function requireLogin(req, res, next) { req.session?.user ? next() : res.redirect('/login'); }

// --- AUTH ---
app.get('/login', (req, res) => {
    if (req.session?.user?.empresa) return res.redirect('/');
    if (req.session?.user) return res.redirect('/empresa');
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { password } = req.body;
    if (!password) return res.render('login', { error: 'Ingrese su clave' });
    try {
        const pool = await generalPool;
        const encPass = icgEncriptar(password);
        const ur = await pool.request().input('p', sql.NVarChar, encPass)
            .query('SELECT CODUSUARIO,USUARIO,NEWPASS,BLOQUEADO,DESCATALOGADO FROM USUARIOS WHERE NEWPASS=@p');
        if (!ur.recordset.length) { logger.warn('Login clave no encontrada'); return res.render('login', { error: 'Clave incorrecta' }); }
        const user = ur.recordset[0];
        if (user.BLOQUEADO?.trim() === 'T') return res.render('login', { error: 'Usuario bloqueado' });
        if (user.DESCATALOGADO?.trim() === 'T') return res.render('login', { error: 'Usuario deshabilitado' });

        const er = await pool.request().input('c', sql.Int, user.CODUSUARIO)
            .query('SELECT E.CODEMPRESA,E.TITULO,E.PATHBD FROM EMPRESASUSUARIO EU INNER JOIN EMPRESAS E ON E.CODEMPRESA=EU.CODEMPRESA WHERE EU.CODUSUARIO=@c ORDER BY EU.POSICION');
        const empresas = er.recordset.map(e => ({ cod: e.CODEMPRESA, titulo: e.TITULO, pathBd: e.PATHBD }));
        if (process.env.EXTRA_EMPRESAS) {
            process.env.EXTRA_EMPRESAS.split(',').forEach((entry, i) => {
                const [t, db] = entry.split(':');
                if (t && db && !empresas.find(e => e.pathBd?.includes(db))) empresas.push({ cod: 9000+i, titulo: t.trim(), pathBd: `LOCALHOST:${db.trim()}` });
            });
        }
        req.session.user = { codUsuario: user.CODUSUARIO, username: user.USUARIO, empresas };
        logger.info(`Login OK: ${user.USUARIO} (${empresas.length} emp)`);
        if (empresas.length === 1) { const e = empresas[0]; req.session.user.empresa = { cod: e.cod, titulo: e.titulo, database: e.pathBd?.split(':')[1] || e.pathBd }; return res.redirect('/'); }
        res.redirect('/empresa');
    } catch (e) { logger.error(`Login: ${e.message}`); res.render('login', { error: 'Error del sistema' }); }
});

app.get('/empresa', requireLogin, (req, res) => { if (req.session.user.empresa) return res.redirect('/'); res.render('empresa', { user: req.session.user }); });
app.post('/empresa', requireLogin, (req, res) => {
    const emp = req.session.user.empresas.find(e => e.cod === parseInt(req.body.codEmpresa));
    if (!emp) return res.redirect('/empresa');
    req.session.user.empresa = { cod: emp.cod, titulo: emp.titulo, database: emp.pathBd?.split(':')[1] || emp.pathBd };
    logger.info(`Empresa: ${emp.titulo} por ${req.session.user.username}`); res.redirect('/');
});
app.get('/logout', (req, res) => { const u = req.session.user?.username||'-'; req.session.destroy(() => { logger.info(`Logout: ${u}`); res.redirect('/login'); }); });
app.get('/cambiar-empresa', requireLogin, (req, res) => { req.session.user.empresa = null; res.redirect('/empresa'); });
app.get('/', requireAuth, (req, res) => res.render('index', { user: req.session.user }));

async function getPool(req) { return getDbPool(req.session.user.empresa.database); }

// --- API: CONFIG ---
app.get('/api/config', requireAuth, async (req, res) => {
    try {
        const pool = await getPool(req);
        const { fecha } = req.query;
        const tasa = await pool.request().input('f', sql.Date, fecha ? new Date(fecha) : new Date())
            .query('SELECT DBO.F_GET_COTIZACION(@f, 1) AS COT');
        const fp = await pool.request().query(`DECLARE @U INT=2,@V INT=1; SELECT CODFORMAPAGO,DESCRIPCION FORMA_PAGO,CODMONEDA,CASE WHEN CODMONEDA=@U THEN 'USD' ELSE 'VES' END MONEDA_ISO FROM FORMASPAGO`);
        res.json({ tasa: tasa.recordset[0].COT || 0, metodos: fp.recordset.map(f => ({ id: f.CODFORMAPAGO, nombre: f.FORMA_PAGO, moneda: f.MONEDA_ISO })) });
    } catch (e) { logger.error(`/api/config: ${e.message}`); res.status(500).json({ error: 'Error configuracion' }); }
});

// --- API: CLIENTES (con datos de campos libres) ---
app.get('/api/clientes', requireAuth, async (req, res) => {
    try {
        const pool = await getPool(req);
        const r = await pool.request().query(`
            SELECT DISTINCT CL.CODCLIENTE, CL.NOMBRECLIENTE,
                CCL.DIASPROTECCION, CCL.ESCALADIASPP1, CCL.ESCALADIASPP2, CCL.ESCALADIASPP3, CCL.ESCALADIASPP4,
                CCL.ESCALAPORPP1, CCL.ESCALAPORPP2, CCL.ESCALAPORPP3, CCL.ESCALAPORPP4
            FROM CLIENTES CL
            INNER JOIN FACTURASVENTA FV ON FV.CODCLIENTE = CL.CODCLIENTE
            INNER JOIN TESORERIA T ON T.SERIE = FV.NUMSERIE AND T.NUMERO = FV.NUMFACTURA AND T.N = FV.N
            LEFT JOIN CLIENTESCAMPOSLIBRES CCL ON CCL.CODCLIENTE = CL.CODCLIENTE
            WHERE T.ESTADO = 'P' AND T.ORIGEN = 'C' AND T.IMPORTE <> 0`);
        res.json(r.recordset);
    } catch (e) { logger.error(`/api/clientes: ${e.message}`); res.status(500).json({ error: 'Error clientes' }); }
});

// --- API: FACTURAS (con fecha entrega y pronto pago) ---
app.get('/api/facturas/:codigo', requireAuth, async (req, res) => {
    try {
        const pool = await getPool(req);
        const r = await pool.request().input('cod', sql.VarChar, req.params.codigo).query(`
            DECLARE @USD AS INT = 2, @VED AS INT = 1;
            SELECT CL.CODCLIENTE, CL.NOMBRECLIENTE, CONCAT(FV.NUMSERIE, ' - ', FV.NUMFACTURA) DOCUMENTO,
                FV.FECHA FECHA_DOCUMENTO,
                RIP.F_GET_COTIZACION_RIP(1, FV.FECHA, 1, @USD, @VED) TASA_ORIGEN,
                SUM(RIP.F_GET_COTIZACION_RIP(T.IMPORTE, T.FECHADOCUMENTO, T.FACTORMONEDA, T.CODMONEDA, @USD)) SALDO_PENDIENTE_USD,
                T.CODFORMAPAGO AS FORMAPAGO_ORIGINAL,
                FVCL.FECHARECIBIDO AS FECHA_ENTREGA,
                CCL.DIASPROTECCION, CCL.ESCALADIASPP1, CCL.ESCALADIASPP2, CCL.ESCALADIASPP3, CCL.ESCALADIASPP4,
                CCL.ESCALAPORPP1, CCL.ESCALAPORPP2, CCL.ESCALAPORPP3, CCL.ESCALAPORPP4,
                MAX(PVC.SUPEDIDO) AS SUPEDIDO,
                MAX(CASE WHEN PVC.SUPEDIDO LIKE '%NI' THEN 1 ELSE 0 END) AS TIENE_NI,
                MAX(CASE WHEN PVC.SUPEDIDO LIKE '%P' OR PVC.SUPEDIDO LIKE '%SD' THEN 1 ELSE 0 END) AS TIENE_CONDICIONADO
            FROM CLIENTES CL
            INNER JOIN FACTURASVENTA FV ON FV.CODCLIENTE = CL.CODCLIENTE
            INNER JOIN TESORERIA T ON T.SERIE = FV.NUMSERIE AND T.NUMERO = FV.NUMFACTURA AND T.N = FV.N
            LEFT JOIN FACTURASVENTACAMPOSLIBRES FVCL ON FVCL.NUMSERIE = FV.NUMSERIE AND FVCL.NUMFACTURA = FV.NUMFACTURA AND FVCL.N = FV.N
            LEFT JOIN CLIENTESCAMPOSLIBRES CCL ON CCL.CODCLIENTE = CL.CODCLIENTE
            LEFT JOIN ALBVENTACAB AVC ON AVC.NUMSERIEFAC = FV.NUMSERIE AND AVC.NUMFAC = FV.NUMFACTURA AND AVC.NFAC = FV.N
            LEFT JOIN PEDVENTACAB PVC ON PVC.SERIEALBARAN = AVC.NUMSERIE AND PVC.NUMEROALBARAN = AVC.NUMALBARAN AND PVC.NALBARAN = AVC.N
            LEFT JOIN CABECERA_PED CP ON CP.ORDERID COLLATE DATABASE_DEFAULT = PVC.SUPEDIDO COLLATE DATABASE_DEFAULT
            WHERE T.ESTADO = 'P' AND T.ORIGEN = 'C' AND CL.CODCLIENTE = @cod AND T.IMPORTE <> 0
            GROUP BY CL.CODCLIENTE, CL.NOMBRECLIENTE, FV.TOTALNETO, FV.FECHA, FV.FACTORMONEDA, FV.CODMONEDA, FV.NUMSERIE, FV.NUMFACTURA,
                T.CODFORMAPAGO, FVCL.FECHARECIBIDO, CCL.DIASPROTECCION,
                CCL.ESCALADIASPP1, CCL.ESCALADIASPP2, CCL.ESCALADIASPP3, CCL.ESCALADIASPP4,
                CCL.ESCALAPORPP1, CCL.ESCALAPORPP2, CCL.ESCALAPORPP3, CCL.ESCALAPORPP4
            ORDER BY FV.FECHA ASC`);

        const hoy = new Date();
        res.json(r.recordset.map(f => {
            const fechaEntrega = f.FECHA_ENTREGA ? new Date(f.FECHA_ENTREGA) : null;
            // Conteo empieza el día SIGUIENTE a la entrega (día entrega = -1, día después = 0)
            const diasDesdeEntrega = fechaEntrega ? Math.floor((hoy - fechaEntrega) / 86400000) - 1 : null;

            const tieneNI = f.TIENE_NI === 1;
            const tieneCondicionado = f.TIENE_CONDICIONADO === 1;

            let descuentoPP = 0;
            let escalaPP = null;
            if (!tieneCondicionado && diasDesdeEntrega !== null && f.ESCALADIASPP1) {
                if (diasDesdeEntrega <= f.ESCALADIASPP1) {
                    descuentoPP = f.ESCALAPORPP1 || 0; escalaPP = 1;
                } else if (f.ESCALADIASPP2 && diasDesdeEntrega <= f.ESCALADIASPP2) {
                    descuentoPP = f.ESCALAPORPP2 || 0; escalaPP = 2;
                } else if (f.ESCALADIASPP3 && diasDesdeEntrega <= f.ESCALADIASPP3) {
                    descuentoPP = f.ESCALAPORPP3 || 0; escalaPP = 3;
                } else if (f.ESCALADIASPP4 && diasDesdeEntrega <= f.ESCALADIASPP4) {
                    descuentoPP = f.ESCALAPORPP4 || 0; escalaPP = 4;
                }
            }

            // Indexadas (no NI) reciben mínimo 2 días de protección de regalo
            const diasProteccion = tieneNI ? 0 : Math.max(f.DIASPROTECCION || 0, 2);
            const protegido = tieneNI ? false : (diasDesdeEntrega !== null && diasProteccion > 0) ? diasDesdeEntrega <= diasProteccion : false;

            return {
                Numero: f.DOCUMENTO,
                Pedido: f.SUPEDIDO || null,
                Fecha: f.FECHA_DOCUMENTO.toISOString().split('T')[0],
                FechaEntrega: fechaEntrega ? fechaEntrega.toISOString().split('T')[0] : null,
                DiasDesdeEntrega: diasDesdeEntrega,
                TasaOrigen: f.TASA_ORIGEN,
                RestanteUSD: f.SALDO_PENDIENTE_USD,
                FormaPagoOriginal: f.FORMAPAGO_ORIGINAL,
                DiasProteccion: diasProteccion,
                Protegido: protegido,
                TieneNI: tieneNI,
                TieneCondicionado: tieneCondicionado,
                DescuentoPP: descuentoPP,
                EscalaPP: escalaPP,
                EscalaDiasPP1: f.ESCALADIASPP1, EscalaPorPP1: f.ESCALAPORPP1,
                EscalaDiasPP2: f.ESCALADIASPP2, EscalaPorPP2: f.ESCALAPORPP2,
                EscalaDiasPP3: f.ESCALADIASPP3, EscalaPorPP3: f.ESCALAPORPP3,
                EscalaDiasPP4: f.ESCALADIASPP4, EscalaPorPP4: f.ESCALAPORPP4
            };
        }));
    } catch (e) { logger.error(`/api/facturas: ${e.message}`); res.status(500).json({ error: 'Error facturas' }); }
});

// --- API: COBRAR ---
app.post('/api/cobrar', requireAuth, async (req, res) => {
    const { detalles, fechaCobro } = req.body;
    const usuario = req.session.user;
    if (!detalles?.length) return res.status(400).json({ error: 'Sin detalles' });
    if (!fechaCobro) return res.status(400).json({ error: 'Fecha requerida' });
    for (const item of detalles) {
        if (!item.documento || isNaN(parseFloat(item.monto)) || parseFloat(item.monto) <= 0) return res.status(400).json({ error: `Datos invalidos: ${item.documento||'-'}` });
        if (!item.formaPagoId) return res.status(400).json({ error: `Forma pago requerida: ${item.documento}` });
    }
    const pool = await getPool(req);
    const tx = new sql.Transaction(pool);
    try {
        await tx.begin();
        logger.info(`Cobro: ${usuario.username} en ${usuario.empresa.titulo} - ${detalles.length} doc(s)`);
        for (const item of detalles) {
            const [serie, numStr] = item.documento.split(' - ');
            const numero = parseInt(numStr);
            const lr = await tx.request().input('s', sql.NVarChar, serie.trim()).input('n', sql.Int, numero)
                .query('SELECT ISNULL(MAX(NUMLINEA),0)+1 AS NL FROM DEX_TESORERIATEMP WHERE SERIE=@s AND NUMERO=@n');
            await tx.request()
                .input('SERIE', sql.NVarChar, serie.trim()).input('NUMERO', sql.Int, numero)
                .input('N', sql.NChar, 'B').input('NUMLINEA', sql.Int, lr.recordset[0].NL)
                .input('CODFORMAPAGO', sql.NVarChar, item.fpOriginal).input('CODTIPOPAGO', sql.NVarChar, item.formaPagoId)
                .input('FECHACOBRO', sql.Date, new Date(fechaCobro))
                .input('CODMONEDA', sql.Int, item.moneda === 'USD' ? 2 : 1)
                .input('FACTORMONEDA', sql.Float, 1 / parseFloat(item.tasaCobro))
                .input('IMPORTE', sql.Float, parseFloat(item.monto))
                .input('FECHAPROCESADO', sql.DateTime, new Date())
                .input('CODUSUARIO', sql.Int, usuario.codUsuario)
                .input('COMENTARIO', sql.NVarChar, item.comentario || '').input('REFERENCIA', sql.NVarChar, item.referencia || '')
                .query(`INSERT INTO [dbo].[DEX_TESORERIATEMP] (SERIE,NUMERO,N,NUMLINEA,CODFORMAPAGO,CODTIPOPAGO,FECHACOBRO,CODMONEDA,FACTORMONEDA,REFERENCIA,COMENTARIO,IMPORTE,FECHAPROCESADO,CODUSUARIO,ESTADO) VALUES (@SERIE,@NUMERO,@N,@NUMLINEA,@CODFORMAPAGO,@CODTIPOPAGO,@FECHACOBRO,@CODMONEDA,@FACTORMONEDA,@REFERENCIA,@COMENTARIO,@IMPORTE,@FECHAPROCESADO,@CODUSUARIO,'0')`);
            logger.info(`  -> ${serie.trim()}-${numero} | ${item.moneda} ${item.monto}`);

            // Notas de crédito/débito: una por PP (NC) y otra por diferencial cambiario
            if (item.montoOriginalUSD != null) {
                const tasaHoy = parseFloat(item.tasaHoy) || parseFloat(item.tasaCobro) || 1;
                const tasaOrig = parseFloat(item.tasaOrig) || tasaHoy;
                const restUSD = parseFloat(item.montoOriginalUSD);
                const pp = parseFloat(item.pp) || 0;
                const monto = parseFloat(item.monto);
                const notas = []; // [{importe, fm}]

                // NC por pronto pago (siempre negativo)
                if (pp > 0) {
                    const importePP = -(restUSD * pp / 100) * tasaOrig;
                    if (Math.abs(importePP) > 1) notas.push({ importe: importePP, fm: 1 / tasaOrig });
                }

                // ND/NC por diferencial cambiario o sobrepago
                let importeDif = null;
                if (item.moneda === 'USD') {
                    const dif = monto - restUSD * (1 - pp / 100);
                    if (Math.abs(dif) > 0.01) importeDif = dif * tasaHoy;
                } else {
                    const dif = monto - restUSD * (1 - pp / 100) * tasaOrig;
                    if (Math.abs(dif) > 1) importeDif = dif;
                }
                if (importeDif !== null) notas.push({ importe: importeDif, fm: 1 / tasaHoy });

                const letrasN = ['B', 'C', 'D', 'E'];
                for (let i = 0; i < notas.length; i++) {
                    await tx.request()
                        .input('SN', sql.NVarChar, serie.trim()).input('NN', sql.Int, numero)
                        .input('NN2', sql.NChar, letrasN[i])
                        .input('FN', sql.Date, new Date(fechaCobro))
                        .input('FM', sql.Float, notas[i].fm)
                        .input('IMP', sql.Float, notas[i].importe)
                        .input('FP', sql.NVarChar, item.fpOriginal)
                        .input('MP', sql.NVarChar, String(item.formaPagoId).substring(0, 2))
                        .input('FPR', sql.DateTime, new Date())
                        .query(`INSERT INTO DEX_TESORERIA_NOTAS (SERIE,NUMERO,N,FECHA,CODMONEDA,FACTORMONEDA,IMPORTE,ESTADO,FECHAPROCESADO,CODFORMAPAGO,CODMEDIOPAGO) VALUES (@SN,@NN,@NN2,@FN,1,@FM,@IMP,'0',@FPR,@FP,@MP)`);
                    logger.info(`  -> Nota ${notas[i].importe < 0 ? 'NC' : 'ND'} [${letrasN[i]}]: ${serie.trim()}-${numero} | VES ${notas[i].importe.toFixed(2)}`);
                }
            }
        }
        await tx.commit();
        if (runSP) {
            try { await pool.request().execute('[rip].[PROC_DEX_PROCESAR_TESORERIA]'); logger.info('SP OK'); }
            catch (pe) { logger.error(`SP: ${pe.message}`); return res.json({ success: true, warning: 'Guardado, error SP: ' + pe.message }); }
        } else { logger.info('SP omitido (desactivado en admin)'); }
        res.json({ success: true, message: 'Cobro registrado y procesado' });
    } catch (e) { try { await tx.rollback(); } catch(_){} logger.error(`Cobro: ${e.message}`); res.status(500).json({ error: 'Error: ' + e.message }); }
});

// --- API: HISTORIAL (fix collation) ---
app.get('/api/historial', requireAuth, async (req, res) => {
    try {
        const pool = await getPool(req);
        const { desde, hasta } = req.query;
        const request = pool.request();
        let q = `SELECT TOP 200 T.SERIE, T.NUMERO, T.FECHACOBRO, T.CODMONEDA, T.IMPORTE,
            T.REFERENCIA, T.COMENTARIO, T.FECHAPROCESADO, T.ESTADO,
            CASE WHEN T.CODMONEDA=2 THEN 'USD' ELSE 'VES' END AS MONEDA_ISO,
            FP.DESCRIPCION AS FORMA_PAGO
            FROM DEX_TESORERIATEMP T
            LEFT JOIN FORMASPAGO FP ON FP.CODFORMAPAGO = T.CODTIPOPAGO COLLATE Modern_Spanish_CI_AS
            WHERE 1=1`;
        if (desde) { q += ' AND T.FECHAPROCESADO>=@desde'; request.input('desde', sql.Date, new Date(desde)); }
        if (hasta) { q += ' AND T.FECHAPROCESADO<=@hasta'; request.input('hasta', sql.Date, new Date(hasta)); }
        q += ' ORDER BY T.FECHAPROCESADO DESC';
        res.json((await request.query(q)).recordset);
    } catch (e) { logger.error(`Historial: ${e.message}`); res.status(500).json({ error: 'Error historial' }); }
});

// --- ADMIN ---
function requireAdmin(req, res, next) {
    if (req.session?.isAdmin) return next();
    res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
    if (req.session?.isAdmin) return res.redirect('/admin');
    res.render('admin-login', { error: null });
});
app.post('/admin/login', (req, res) => {
    if (req.body.pass === (process.env.APP_PASS || 'admin123')) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }
    res.render('admin-login', { error: 'Clave incorrecta' });
});
app.get('/admin/logout', (req, res) => { req.session.isAdmin = false; res.redirect('/admin/login'); });
app.get('/admin/sp-status', requireAdmin, (req, res) => res.json({ runSP }));
app.post('/admin/toggle-sp', requireAdmin, (req, res) => { runSP = req.body.enabled === true || req.body.enabled === 'true'; logger.info(`SP ${runSP ? 'activado' : 'desactivado'} por admin`); res.json({ runSP }); });
app.get('/admin', requireAdmin, (req, res) => res.render('admin', { user: req.session.user }));

// Verifica clave admin desde el app principal (para modal PP)
app.post('/api/admin/auth', requireAuth, (req, res) => {
    req.body.pass === (process.env.APP_PASS || 'admin123') ? res.json({ ok: true }) : res.status(401).json({ error: 'Clave incorrecta' });
});

// Helpers actualización
function downloadZip(url, dest, hops = 0) {
    return new Promise((resolve, reject) => {
        if (hops > 5) return reject(new Error('Too many redirects'));
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, res => {
            if ([301, 302, 307, 308].includes(res.statusCode))
                return downloadZip(res.headers.location, dest, hops + 1).then(resolve).catch(reject);
            const f = fs.createWriteStream(dest);
            res.pipe(f);
            f.on('finish', () => f.close(resolve));
            f.on('error', reject);
        }).on('error', reject);
    });
}

function copyDirSync(src, dest, skip = []) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
        if (skip.includes(e)) continue;
        const s = path.join(src, e), d = path.join(dest, e);
        fs.statSync(s).isDirectory() ? copyDirSync(s, d, []) : fs.copyFileSync(s, d);
    }
}

app.post('/admin/update', requireAdmin, async (req, res) => {
    const zipPath = path.join(os.tmpdir(), 'cobranza-update.zip');
    const extractPath = path.join(os.tmpdir(), 'cobranza-update-ext');
    try {
        logger.info('Actualizacion: descargando desde GitHub...');
        await downloadZip('https://github.com/Roalcoma/Cobranza-Drogueria/archive/refs/heads/main.zip', zipPath);
        if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true });
        await new Promise((resolve, reject) =>
            exec(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`, e => e ? reject(e) : resolve())
        );
        const extracted = fs.readdirSync(extractPath)[0];
        copyDirSync(path.join(extractPath, extracted), __dirname, ['.env', 'node_modules', 'logs', '.git']);
        fs.unlinkSync(zipPath);
        fs.rmSync(extractPath, { recursive: true });
        logger.info('Actualizacion aplicada correctamente');
        res.json({ success: true });
    } catch (e) {
        logger.error(`Update: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/restart', requireAdmin, (req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
        spawn('node', [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore', cwd: __dirname }).unref();
        process.exit(0);
    }, 500);
});

app.listen(PORT, () => logger.info(`Servidor en puerto ${PORT}`));
