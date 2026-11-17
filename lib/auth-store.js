const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { httpError } = require('./exam-store');

const scrypt = promisify(crypto.scrypt);

const PERMISSIONS = [
    { key: 'invigilation', label: 'Invigilation' },
    { key: 'questions', label: 'Create exam questions' },
    { key: 'subjects', label: 'Manage subjects' },
    { key: 'quizzes', label: 'Create quizzes' },
    { key: 'users', label: 'Create users' },
    { key: 'students', label: 'Upload students' }
];
const PERMISSION_KEYS = PERMISSIONS.map(permission => permission.key);

const REFERRAL_OPTIONS = [
    'Search engine',
    'Social media',
    'Referral from a colleague',
    'Education conference or event',
    'Direct outreach from Verot',
    'Other'
];

const SESSION_KINDS = ['staff', 'student'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function makeId(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeEmail(value) {
    const email = cleanText(value, 160).toLowerCase();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address');
    return email;
}

function normalizePassword(value) {
    const password = typeof value === 'string' ? value : '';
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (password.length > 200) throw httpError(400, 'Password is too long');
    return password;
}

function normalizePermissions(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return [...new Set(list.filter(key => PERMISSION_KEYS.includes(key)))];
}

function normalizeRegistration(input = {}) {
    const companyName = cleanText(input.companyName, 120);
    if (companyName.length < 2) throw httpError(400, 'Company name is required');

    const email = normalizeEmail(input.email);
    const contact = cleanText(input.contact, 40);
    if (contact.length < 5) throw httpError(400, 'Contact number is required');

    const address = cleanText(input.address, 300);
    if (address.length < 5) throw httpError(400, 'Company address is required');

    const referral = cleanText(input.referral, 60);
    if (!REFERRAL_OPTIONS.includes(referral)) throw httpError(400, 'Select how you heard about us');

    const password = normalizePassword(input.password);
    const adminName = cleanText(input.adminName, 120) || `${companyName} admin`;

    return {
        company: { name: companyName, email, contact, address, referral },
        adminName,
        password
    };
}

function normalizeTeamUser(input = {}, { requirePassword = true } = {}) {
    const name = cleanText(input.name, 120);
    if (name.length < 2) throw httpError(400, 'Full name is required');

    const email = normalizeEmail(input.email);
    const role = input.role === 'admin' ? 'admin' : 'member';
    let permissions = normalizePermissions(input.permissions);
    if (role === 'member' && permissions.length === 0) {
        throw httpError(400, 'Choose at least one access permission');
    }
    if (role === 'admin') permissions = [];

    let password = null;
    if (requirePassword || input.password) {
        password = normalizePassword(input.password);
    }

    return { name, email, role, permissions, password };
}

function normalizeStudentInput(raw = {}) {
    const fullName = cleanText(raw.fullName || raw.fullname || raw.name, 120);
    if (fullName.length < 2) throw httpError(400, 'Full name is required');

    const studentNumber = cleanText(
        raw.studentNumber || raw.studentnumber || raw.student_number || raw.number,
        60
    );
    if (!studentNumber) throw httpError(400, 'Student number is required');

    const email = normalizeEmail(raw.email);
    return { fullName, studentNumber, email };
}

function parseJsonColumn(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    try {
        const salt = Buffer.from(parts[1], 'hex');
        const expected = Buffer.from(parts[2], 'hex');
        const derived = await scrypt(password, salt, expected.length);
        return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    } catch (error) {
        return false;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function effectivePermissions(user) {
    if (!user) return [];
    return user.role === 'admin' ? PERMISSION_KEYS.slice() : normalizePermissions(user.permissions);
}

function hasPermission(user, permission) {
    if (!user || user.status === 'disabled') return false;
    if (user.role === 'admin') return true;
    return normalizePermissions(user.permissions).includes(permission);
}

function publicUser(user) {
    const permissions = effectivePermissions(user);
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions,
        isAdmin: user.role === 'admin',
        status: user.status,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt || null
    };
}

function publicStudent(student) {
    return {
        id: student.id,
        fullName: student.fullName,
        studentNumber: student.studentNumber,
        email: student.email,
        createdAt: student.createdAt
    };
}

function publicCompany(company) {
    return {
        id: company.id,
        name: company.name,
        email: company.email,
        contact: company.contact,
        address: company.address,
        referral: company.referral,
        createdAt: company.createdAt
    };
}

function rowToCompany(row) {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        contact: row.contact || '',
        address: row.address || '',
        referral: row.referral || '',
        createdAt: Number(row.created_at) || 0
    };
}

function rowToUser(row) {
    return {
        id: row.id,
        companyId: row.company_id,
        name: row.name,
        email: row.email,
        passwordHash: row.password_hash,
        role: row.role === 'admin' ? 'admin' : 'member',
        permissions: parseJsonColumn(row.permissions, []),
        status: row.status || 'active',
        createdAt: Number(row.created_at) || 0,
        lastLoginAt: Number(row.last_login_at) || null
    };
}

function rowToStudent(row) {
    return {
        id: row.id,
        companyId: row.company_id,
        fullName: row.full_name,
        studentNumber: row.student_number,
        email: row.email,
        createdAt: Number(row.created_at) || 0
    };
}

function rowToSession(row) {
    return {
        tokenHash: row.token_hash,
        kind: row.kind,
        subjectId: row.subject_id,
        companyId: row.company_id || '',
        expiresAt: Number(row.expires_at) || 0,
        createdAt: Number(row.created_at) || 0
    };
}

class JsonDriver {
    constructor(file) {
        this.file = file;
        this.name = 'json';
        this.data = { companies: [], users: [], students: [], sessions: [] };
        this._write = Promise.resolve();
    }

    async init() {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        let loaded = false;
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = {
                companies: Array.isArray(parsed.companies) ? parsed.companies : [],
                users: Array.isArray(parsed.users) ? parsed.users : [],
                students: Array.isArray(parsed.students) ? parsed.students : [],
                sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
            };
            loaded = true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('Could not read auth store, starting empty:', error.message);
            }
        }
        if (!loaded) await this.persist();
    }

    persist() {
        const snapshot = JSON.stringify(this.data, null, 2);
        const tempFile = `${this.file}.tmp`;
        this._write = this._write
            .catch(() => {})
            .then(async () => {
                await fs.writeFile(tempFile, snapshot, 'utf8');
                await fs.rename(tempFile, this.file);
            });
        return this._write;
    }

    async createCompanyWithAdmin(company, admin) {
        if (this.data.companies.some(item => item.email === company.email)) {
            throw httpError(409, 'An account with this email already exists');
        }
        if (this.data.users.some(item => item.email === admin.email)) {
            throw httpError(409, 'An account with this email already exists');
        }
        this.data.companies.push(company);
        this.data.users.push(admin);
        await this.persist();
        return { company, user: admin };
    }

    async getCompany(id) {
        return this.data.companies.find(company => company.id === id) || null;
    }

    async findUserByEmail(email) {
        return this.data.users.find(user => user.email === email) || null;
    }

    async getUserById(id) {
        return this.data.users.find(user => user.id === id) || null;
    }

    async listUsers(companyId) {
        return this.data.users
            .filter(user => user.companyId === companyId)
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }

    async createUser(user) {
        if (this.data.users.some(item => item.email === user.email)) {
            throw httpError(409, 'An account with this email already exists');
        }
        this.data.users.push(user);
        await this.persist();
        return user;
    }

    async updateUser(companyId, id, changes) {
        const index = this.data.users.findIndex(user => user.id === id && user.companyId === companyId);
        if (index === -1) throw httpError(404, 'User not found');
        const record = { ...this.data.users[index], ...changes, id, companyId };
        this.data.users[index] = record;
        await this.persist();
        return record;
    }

    async deleteUser(companyId, id) {
        const before = this.data.users.length;
        this.data.users = this.data.users.filter(user => !(user.id === id && user.companyId === companyId));
        if (this.data.users.length === before) throw httpError(404, 'User not found');
        await this.persist();
    }

    async countAdmins(companyId) {
        return this.data.users.filter(user => user.companyId === companyId && user.role === 'admin').length;
    }

    async updateLastLogin(id) {
        const user = this.data.users.find(item => item.id === id);
        if (!user) return;
        user.lastLoginAt = Date.now();
        await this.persist();
    }

    async createSession(session) {
        this.data.sessions.push(session);
        await this.persist();
    }

    async getSession(tokenHash) {
        return this.data.sessions.find(session => session.tokenHash === tokenHash) || null;
    }

    async deleteSession(tokenHash) {
        const before = this.data.sessions.length;
        this.data.sessions = this.data.sessions.filter(session => session.tokenHash !== tokenHash);
        if (this.data.sessions.length !== before) await this.persist();
    }

    async deleteExpiredSessions(now) {
        const before = this.data.sessions.length;
        this.data.sessions = this.data.sessions.filter(session => session.expiresAt > now);
        if (this.data.sessions.length !== before) await this.persist();
    }

    async listStudents(companyId) {
        return this.data.students
            .filter(student => student.companyId === companyId)
            .sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    async findStudentByNumber(companyId, studentNumber) {
        const needle = studentNumber.toLowerCase();
        return this.data.students.find(student =>
            student.companyId === companyId && student.studentNumber.toLowerCase() === needle
        ) || null;
    }

    async findStudentByEmail(companyId, email) {
        const needle = email.toLowerCase();
        return this.data.students.find(student =>
            student.companyId === companyId && student.email.toLowerCase() === needle
        ) || null;
    }

    async getStudentById(id) {
        return this.data.students.find(student => student.id === id) || null;
    }

    async createStudent(student) {
        if (await this.findStudentByNumber(student.companyId, student.studentNumber)) {
            throw httpError(409, 'Student number already exists');
        }
        if (await this.findStudentByEmail(student.companyId, student.email)) {
            throw httpError(409, 'Student email already exists');
        }
        this.data.students.push(student);
        await this.persist();
        return student;
    }

    async updateStudent(companyId, id, changes) {
        const index = this.data.students.findIndex(student => student.id === id && student.companyId === companyId);
        if (index === -1) throw httpError(404, 'Student not found');
        const record = { ...this.data.students[index], ...changes, id, companyId };
        this.data.students[index] = record;
        await this.persist();
        return record;
    }

    async deleteStudent(companyId, id) {
        const before = this.data.students.length;
        this.data.students = this.data.students.filter(student => !(student.id === id && student.companyId === companyId));
        if (this.data.students.length === before) throw httpError(404, 'Student not found');
        await this.persist();
    }
}

class MysqlDriver {
    constructor(config) {
        this.config = config;
        this.name = 'mysql';
        this.pool = null;
    }

    async init() {
        const mysql = require('mysql2/promise');
        this.pool = mysql.createPool({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
            database: this.config.database,
            waitForConnections: true,
            connectionLimit: 5,
            charset: 'utf8mb4'
        });

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS companies (
                id VARCHAR(32) PRIMARY KEY,
                name VARCHAR(120) NOT NULL,
                email VARCHAR(160) NOT NULL UNIQUE,
                contact VARCHAR(40) NOT NULL DEFAULT '',
                address VARCHAR(300) NOT NULL DEFAULT '',
                referral VARCHAR(60) NOT NULL DEFAULT '',
                created_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS company_users (
                id VARCHAR(32) PRIMARY KEY,
                company_id VARCHAR(32) NOT NULL,
                name VARCHAR(120) NOT NULL,
                email VARCHAR(160) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(10) NOT NULL DEFAULT 'member',
                permissions JSON NOT NULL,
                status VARCHAR(10) NOT NULL DEFAULT 'active',
                created_at BIGINT NOT NULL,
                last_login_at BIGINT NULL,
                KEY idx_company_users_company (company_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS students (
                id VARCHAR(32) PRIMARY KEY,
                company_id VARCHAR(32) NOT NULL,
                full_name VARCHAR(120) NOT NULL,
                student_number VARCHAR(60) NOT NULL,
                email VARCHAR(160) NOT NULL,
                created_at BIGINT NOT NULL,
                UNIQUE KEY uniq_student_number (company_id, student_number),
                UNIQUE KEY uniq_student_email (company_id, email),
                KEY idx_students_company (company_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash CHAR(64) PRIMARY KEY,
                kind VARCHAR(10) NOT NULL,
                subject_id VARCHAR(32) NOT NULL,
                company_id VARCHAR(32) NOT NULL DEFAULT '',
                expires_at BIGINT NOT NULL,
                created_at BIGINT NOT NULL,
                KEY idx_auth_sessions_expiry (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    async createCompanyWithAdmin(company, admin) {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(
                `INSERT INTO companies (id, name, email, contact, address, referral, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [company.id, company.name, company.email, company.contact,
                 company.address, company.referral, company.createdAt]
            );
            await connection.query(
                `INSERT INTO company_users
                 (id, company_id, name, email, password_hash, role, permissions, status, created_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [admin.id, admin.companyId, admin.name, admin.email, admin.passwordHash,
                 admin.role, JSON.stringify(admin.permissions), admin.status,
                 admin.createdAt, admin.lastLoginAt]
            );
            await connection.commit();
            return { company, user: admin };
        } catch (error) {
            await connection.rollback();
            if (error.code === 'ER_DUP_ENTRY') {
                throw httpError(409, 'An account with this email already exists');
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    async getCompany(id) {
        const [rows] = await this.pool.query('SELECT * FROM companies WHERE id = ?', [id]);
        return rows.length ? rowToCompany(rows[0]) : null;
    }

    async findUserByEmail(email) {
        const [rows] = await this.pool.query('SELECT * FROM company_users WHERE email = ?', [email]);
        return rows.length ? rowToUser(rows[0]) : null;
    }

    async getUserById(id) {
        const [rows] = await this.pool.query('SELECT * FROM company_users WHERE id = ?', [id]);
        return rows.length ? rowToUser(rows[0]) : null;
    }

    async listUsers(companyId) {
        const [rows] = await this.pool.query(
            'SELECT * FROM company_users WHERE company_id = ? ORDER BY created_at ASC',
            [companyId]
        );
        return rows.map(rowToUser);
    }

    async createUser(user) {
        try {
            await this.pool.query(
                `INSERT INTO company_users
                 (id, company_id, name, email, password_hash, role, permissions, status, created_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user.id, user.companyId, user.name, user.email, user.passwordHash,
                 user.role, JSON.stringify(user.permissions), user.status,
                 user.createdAt, user.lastLoginAt]
            );
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw httpError(409, 'An account with this email already exists');
            }
            throw error;
        }
        return user;
    }

    async updateUser(companyId, id, changes) {
        const existing = await this.getUserById(id);
        if (!existing || existing.companyId !== companyId) throw httpError(404, 'User not found');
        const record = { ...existing, ...changes, id, companyId };
        try {
            await this.pool.query(
                `UPDATE company_users
                 SET name = ?, email = ?, password_hash = ?, role = ?, permissions = ?, status = ?
                 WHERE id = ? AND company_id = ?`,
                [record.name, record.email, record.passwordHash, record.role,
                 JSON.stringify(record.permissions), record.status, id, companyId]
            );
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw httpError(409, 'An account with this email already exists');
            }
            throw error;
        }
        return record;
    }

    async deleteUser(companyId, id) {
        const [result] = await this.pool.query(
            'DELETE FROM company_users WHERE id = ? AND company_id = ?',
            [id, companyId]
        );
        if (!result.affectedRows) throw httpError(404, 'User not found');
    }

    async countAdmins(companyId) {
        const [rows] = await this.pool.query(
            "SELECT COUNT(*) AS total FROM company_users WHERE company_id = ? AND role = 'admin'",
            [companyId]
        );
        return Number(rows[0] && rows[0].total) || 0;
    }

    async updateLastLogin(id) {
        await this.pool.query('UPDATE company_users SET last_login_at = ? WHERE id = ?', [Date.now(), id]);
    }

    async createSession(session) {
        await this.pool.query(
            `INSERT INTO auth_sessions (token_hash, kind, subject_id, company_id, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [session.tokenHash, session.kind, session.subjectId, session.companyId,
             session.expiresAt, session.createdAt]
        );
    }

    async getSession(tokenHash) {
        const [rows] = await this.pool.query('SELECT * FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
        return rows.length ? rowToSession(rows[0]) : null;
    }

    async deleteSession(tokenHash) {
        await this.pool.query('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
    }

    async deleteExpiredSessions(now) {
        await this.pool.query('DELETE FROM auth_sessions WHERE expires_at <= ?', [now]);
    }

    async listStudents(companyId) {
        const [rows] = await this.pool.query(
            'SELECT * FROM students WHERE company_id = ? ORDER BY full_name ASC',
            [companyId]
        );
        return rows.map(rowToStudent);
    }

    async findStudentByNumber(companyId, studentNumber) {
        const [rows] = await this.pool.query(
            'SELECT * FROM students WHERE company_id = ? AND LOWER(student_number) = LOWER(?)',
            [companyId, studentNumber]
        );
        return rows.length ? rowToStudent(rows[0]) : null;
    }

    async findStudentByEmail(companyId, email) {
        const [rows] = await this.pool.query(
            'SELECT * FROM students WHERE company_id = ? AND LOWER(email) = LOWER(?)',
            [companyId, email]
        );
        return rows.length ? rowToStudent(rows[0]) : null;
    }

    async getStudentById(id) {
        const [rows] = await this.pool.query('SELECT * FROM students WHERE id = ?', [id]);
        return rows.length ? rowToStudent(rows[0]) : null;
    }

    async createStudent(student) {
        try {
            await this.pool.query(
                `INSERT INTO students (id, company_id, full_name, student_number, email, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [student.id, student.companyId, student.fullName, student.studentNumber,
                 student.email, student.createdAt]
            );
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw httpError(409, 'Student number or email already exists');
            }
            throw error;
        }
        return student;
    }

    async updateStudent(companyId, id, changes) {
        const existing = await this.getStudentById(id);
        if (!existing || existing.companyId !== companyId) throw httpError(404, 'Student not found');
        const record = { ...existing, ...changes, id, companyId };
        try {
            await this.pool.query(
                `UPDATE students SET full_name = ?, student_number = ?, email = ?
                 WHERE id = ? AND company_id = ?`,
                [record.fullName, record.studentNumber, record.email, id, companyId]
            );
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                throw httpError(409, 'Student number or email already exists');
            }
            throw error;
        }
        return record;
    }

    async deleteStudent(companyId, id) {
        const [result] = await this.pool.query(
            'DELETE FROM students WHERE id = ? AND company_id = ?',
            [id, companyId]
        );
        if (!result.affectedRows) throw httpError(404, 'Student not found');
    }
}

class AuthStore {
    constructor() {
        this.driver = null;
        this.ready = this.init();
    }

    async init() {
        const { MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE } = process.env;
        if (MYSQL_HOST && MYSQL_USER && MYSQL_DATABASE) {
            try {
                const driver = new MysqlDriver({
                    host: MYSQL_HOST,
                    port: Number.parseInt(process.env.MYSQL_PORT, 10) || 3306,
                    user: MYSQL_USER,
                    password: process.env.MYSQL_PASSWORD || '',
                    database: MYSQL_DATABASE
                });
                await driver.init();
                this.driver = driver;
                console.log('🗄️  Accounts and students using MySQL database:', MYSQL_DATABASE);
                return;
            } catch (error) {
                console.error('❌ MySQL auth connection failed, falling back to JSON store:', error.message);
            }
        }

        const file = process.env.AUTH_STORE_FILE || path.join(__dirname, '..', 'data', 'auth.json');
        const driver = new JsonDriver(file);
        await driver.init();
        this.driver = driver;
        console.log('🗄️  Accounts and students using JSON store:', file);
    }

    get storageName() {
        return this.driver ? this.driver.name : 'initializing';
    }

    async register(input) {
        await this.ready;
        const registration = normalizeRegistration(input);
        const now = Date.now();
        const company = {
            ...registration.company,
            id: makeId('co'),
            createdAt: now
        };
        const passwordHash = await hashPassword(registration.password);
        const admin = {
            id: makeId('u'),
            companyId: company.id,
            name: registration.adminName,
            email: company.email,
            passwordHash,
            role: 'admin',
            permissions: [],
            status: 'active',
            createdAt: now,
            lastLoginAt: now
        };
        const result = await this.driver.createCompanyWithAdmin(company, admin);
        return result;
    }

    async login(emailInput, password) {
        await this.ready;
        let email;
        try {
            email = normalizeEmail(emailInput);
        } catch (error) {
            throw httpError(401, 'Invalid email or password');
        }
        const user = await this.driver.findUserByEmail(email);
        const valid = user ? await verifyPassword(typeof password === 'string' ? password : '', user.passwordHash) : false;
        if (!valid) throw httpError(401, 'Invalid email or password');
        if (user.status !== 'active') throw httpError(403, 'This account has been disabled');
        const company = await this.driver.getCompany(user.companyId);
        if (!company) throw httpError(403, 'This account is no longer linked to an institution');
        await this.driver.updateLastLogin(user.id);
        return { user: { ...user, lastLoginAt: Date.now() }, company };
    }

    async getCompany(id) {
        await this.ready;
        return this.driver.getCompany(id);
    }

    async getUserById(id) {
        await this.ready;
        return this.driver.getUserById(id);
    }

    async listTeam(companyId) {
        await this.ready;
        const users = await this.driver.listUsers(companyId);
        return users.map(publicUser);
    }

    async createTeamUser(actor, input) {
        await this.ready;
        const normalized = normalizeTeamUser(input);
        if (normalized.role === 'admin' && actor.role !== 'admin') {
            throw httpError(403, 'Only an administrator can assign administrator access');
        }
        if (actor.role !== 'admin') {
            const extra = normalized.permissions.filter(permission => !hasPermission(actor, permission));
            if (extra.length) {
                throw httpError(403, 'You can only grant permissions you already hold');
            }
        }

        const passwordHash = await hashPassword(normalized.password);
        const user = {
            id: makeId('u'),
            companyId: actor.companyId,
            name: normalized.name,
            email: normalized.email,
            passwordHash,
            role: normalized.role,
            permissions: normalized.permissions,
            status: 'active',
            createdAt: Date.now(),
            lastLoginAt: null
        };
        return publicUser(await this.driver.createUser(user));
    }

    async updateTeamUser(actor, id, input = {}) {
        await this.ready;
        const target = await this.driver.getUserById(id);
        if (!target || target.companyId !== actor.companyId) throw httpError(404, 'User not found');

        const targetIsAdmin = target.role === 'admin';
        if (targetIsAdmin && actor.role !== 'admin') {
            throw httpError(403, 'Only an administrator can manage another administrator');
        }
        if (actor.role !== 'admin') {
            const privileged = effectivePermissions(target).some(permission => !hasPermission(actor, permission));
            if (privileged) {
                throw httpError(403, 'You cannot manage a user with wider access than your own');
            }
        }

        const requestedRole = input.role === 'admin' ? 'admin' : input.role === 'member' ? 'member' : target.role;
        if (requestedRole === 'admin' && actor.role !== 'admin') {
            throw httpError(403, 'Only an administrator can assign administrator access');
        }
        if (id === actor.id && requestedRole !== target.role) {
            throw httpError(400, 'You cannot change your own role');
        }

        const role = requestedRole;
        let permissions = target.permissions;
        if (role === 'admin') {
            permissions = [];
        } else {
            permissions = input.permissions === undefined
                ? normalizePermissions(target.permissions)
                : normalizePermissions(input.permissions);
            if (!permissions.length) throw httpError(400, 'Choose at least one access permission');
            if (actor.role !== 'admin') {
                const extra = permissions.filter(permission => !hasPermission(actor, permission));
                if (extra.length) throw httpError(403, 'You can only grant permissions you already hold');
            }
        }

        if (targetIsAdmin && role !== 'admin' && (await this.driver.countAdmins(actor.companyId)) <= 1) {
            throw httpError(400, 'Keep at least one administrator for this company');
        }

        const changes = {
            name: cleanText(input.name, 120) || target.name,
            email: input.email === undefined ? target.email : normalizeEmail(input.email),
            role,
            permissions
        };
        if (input.password) {
            changes.passwordHash = await hashPassword(normalizePassword(input.password));
        }
        return publicUser(await this.driver.updateUser(actor.companyId, id, changes));
    }

    async deleteTeamUser(actor, id) {
        await this.ready;
        if (id === actor.id) throw httpError(400, 'You cannot remove your own account');
        const target = await this.driver.getUserById(id);
        if (!target || target.companyId !== actor.companyId) throw httpError(404, 'User not found');
        if (target.role === 'admin') {
            if (actor.role !== 'admin') throw httpError(403, 'Only an administrator can remove another administrator');
            if ((await this.driver.countAdmins(actor.companyId)) <= 1) {
                throw httpError(400, 'Keep at least one administrator for this company');
            }
        } else if (actor.role !== 'admin') {
            const privileged = effectivePermissions(target).some(permission => !hasPermission(actor, permission));
            if (privileged) throw httpError(403, 'You cannot remove a user with wider access than your own');
        }
        await this.driver.deleteUser(actor.companyId, id);
    }

    async createSession(kind, subjectId, companyId, ttlMs) {
        await this.ready;
        if (!SESSION_KINDS.includes(kind)) throw new Error('Invalid session kind');
        const token = crypto.randomBytes(32).toString('hex');
        await this.driver.createSession({
            tokenHash: hashToken(token),
            kind,
            subjectId,
            companyId: companyId || '',
            expiresAt: Date.now() + ttlMs,
            createdAt: Date.now()
        });
        return token;
    }

    async getSession(token) {
        await this.ready;
        if (!token) return null;
        const session = await this.driver.getSession(hashToken(token));
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            await this.driver.deleteSession(session.tokenHash);
            return null;
        }
        return session;
    }

    async deleteSession(token) {
        await this.ready;
        if (!token) return;
        await this.driver.deleteSession(hashToken(token));
    }

    async cleanupSessions() {
        await this.ready;
        await this.driver.deleteExpiredSessions(Date.now());
    }

    async getStudentById(id) {
        await this.ready;
        return this.driver.getStudentById(id);
    }

    async listStudents(companyId, search = '') {
        await this.ready;
        const students = await this.driver.listStudents(companyId);
        const query = cleanText(search, 120).toLowerCase();
        if (!query) return students;
        return students.filter(student =>
            `${student.fullName} ${student.studentNumber} ${student.email}`.toLowerCase().includes(query)
        );
    }

    async importStudents(companyId, rows) {
        await this.ready;
        if (!Array.isArray(rows) || rows.length === 0) {
            throw httpError(400, 'No student rows found in this file');
        }
        if (rows.length > 2000) {
            throw httpError(400, 'Upload at most 2000 students at a time');
        }

        const existing = await this.driver.listStudents(companyId);
        const byNumber = new Map(existing.map(student => [student.studentNumber.toLowerCase(), student]));
        const byEmail = new Map(existing.map(student => [student.email.toLowerCase(), student]));
        const seenNumbers = new Set();
        const seenEmails = new Set();
        const errors = [];
        let created = 0;
        let updated = 0;
        let unchanged = 0;

        for (let index = 0; index < rows.length; index += 1) {
            const rowNumber = index + 2;
            try {
                const input = normalizeStudentInput(rows[index]);
                const numberKey = input.studentNumber.toLowerCase();
                const emailKey = input.email.toLowerCase();

                if (seenNumbers.has(numberKey)) throw httpError(400, 'Duplicate student number in this file');
                if (seenEmails.has(emailKey)) throw httpError(400, 'Duplicate email in this file');

                const emailOwner = byEmail.get(emailKey);
                const current = byNumber.get(numberKey);
                if (emailOwner && (!current || emailOwner.id !== current.id)) {
                    throw httpError(400, 'Email already belongs to another student');
                }

                if (current) {
                    if (current.fullName !== input.fullName || current.email !== input.email) {
                        if (current.email.toLowerCase() !== emailKey) {
                            byEmail.delete(current.email.toLowerCase());
                        }
                        const saved = await this.driver.updateStudent(companyId, current.id, input);
                        byNumber.set(numberKey, saved);
                        byEmail.set(emailKey, saved);
                        updated += 1;
                    } else {
                        unchanged += 1;
                    }
                } else {
                    const saved = await this.driver.createStudent({
                        ...input,
                        id: makeId('s'),
                        companyId,
                        createdAt: Date.now()
                    });
                    byNumber.set(numberKey, saved);
                    byEmail.set(emailKey, saved);
                    created += 1;
                }

                seenNumbers.add(numberKey);
                seenEmails.add(emailKey);
            } catch (error) {
                errors.push({
                    row: rowNumber,
                    studentNumber: cleanText(
                        rows[index] && (rows[index].studentNumber || rows[index].studentnumber),
                        60
                    ),
                    message: error.message
                });
            }
        }

        return {
            total: rows.length,
            created,
            updated,
            unchanged,
            skipped: errors.length,
            errors: errors.slice(0, 100)
        };
    }

    async deleteStudent(companyId, id) {
        await this.ready;
        await this.driver.deleteStudent(companyId, id);
    }

    async verifyStudent(companyId, studentNumber, emailInput) {
        await this.ready;
        const number = cleanText(studentNumber, 60);
        if (!number) throw httpError(400, 'Enter your student number');
        const email = normalizeEmail(emailInput);

        const student = await this.driver.findStudentByNumber(companyId, number);
        if (!student) {
            throw httpError(403, 'This student number is not on the institution register');
        }
        if (student.email.toLowerCase() !== email) {
            throw httpError(403, 'The email does not match this student number');
        }
        return student;
    }
}

module.exports = {
    AuthStore,
    PERMISSIONS,
    PERMISSION_KEYS,
    REFERRAL_OPTIONS,
    hasPermission,
    effectivePermissions,
    publicUser,
    publicStudent,
    publicCompany
};
