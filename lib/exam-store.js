const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const QUESTION_TYPES = ['single', 'multiple', 'truefalse', 'short'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const TRUE_FALSE_OPTIONS = ['True', 'False'];

function makeId(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
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

function normalizeOptions(type, rawOptions) {
    if (type === 'truefalse') return TRUE_FALSE_OPTIONS.slice();
    if (type === 'short') return [];

    const options = Array.isArray(rawOptions) ? rawOptions : [];
    const cleaned = options
        .map(option => cleanText(option, 300))
        .filter(Boolean)
        .slice(0, 8);

    if (cleaned.length < 2) {
        throw httpError(400, 'Add at least two answer options');
    }
    return cleaned;
}

function normalizeCorrect(type, rawCorrect, optionCount) {
    if (type === 'short') return [];

    const values = Array.isArray(rawCorrect) ? rawCorrect : [rawCorrect];
    const indices = [...new Set(values
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isInteger(value) && value >= 0 && value < optionCount))]
        .sort((a, b) => a - b);

    if (indices.length === 0) {
        throw httpError(400, 'Select the correct answer');
    }
    if ((type === 'single' || type === 'truefalse') && indices.length !== 1) {
        throw httpError(400, 'Single choice questions need exactly one correct answer');
    }
    return indices;
}

function normalizeQuestion(input = {}) {
    const type = QUESTION_TYPES.includes(input.type) ? input.type : 'single';
    const subject = cleanText(input.subject, 80);
    if (subject.length < 2) {
        throw httpError(400, 'Subject is required');
    }

    const prompt = cleanText(input.prompt, 2000);
    if (prompt.length < 3) {
        throw httpError(400, 'Question text is required');
    }

    const options = normalizeOptions(type, input.options);
    const correct = normalizeCorrect(type, input.correct, options.length);

    return {
        subject,
        topic: cleanText(input.topic, 120),
        type,
        prompt,
        options,
        correct,
        marks: clampInt(input.marks, 1, 20, 1),
        difficulty: DIFFICULTIES.includes(input.difficulty) ? input.difficulty : 'medium'
    };
}

function normalizeExamQuestions(rawQuestions, questionLookup) {
    const list = Array.isArray(rawQuestions) ? rawQuestions.slice(0, 200) : [];
    const seen = new Set();
    const questions = [];

    for (const item of list) {
        const questionId = cleanText(item && item.questionId, 64);
        if (!questionId || seen.has(questionId)) continue;
        const question = questionLookup.get(questionId);
        if (!question) continue;
        seen.add(questionId);
        questions.push({
            questionId,
            marks: clampInt(item.marks, 1, 20, question.marks || 1)
        });
    }
    return questions;
}

function normalizeExam(input = {}, questionLookup = new Map()) {
    const title = cleanText(input.title, 120);
    if (title.length < 2) {
        throw httpError(400, 'Exam title is required');
    }

    return {
        title,
        description: cleanText(input.description, 500),
        subject: cleanText(input.subject, 80),
        durationMinutes: clampInt(input.durationMinutes, 5, 480, 60),
        questions: normalizeExamQuestions(input.questions, questionLookup)
    };
}

function rowToQuestion(row) {
    return {
        id: row.id,
        subject: row.subject,
        topic: row.topic || '',
        type: row.type,
        prompt: row.prompt,
        options: parseJsonColumn(row.options, []),
        correct: parseJsonColumn(row.correct, []),
        marks: Number(row.marks) || 1,
        difficulty: row.difficulty || 'medium',
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0
    };
}

function rowToExam(row) {
    return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        subject: row.subject || '',
        durationMinutes: Number(row.duration_minutes) || 60,
        questions: parseJsonColumn(row.questions, []),
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0
    };
}

function sortByUpdated(list) {
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function applyQuestionFilters(questions, filters = {}) {
    const subject = cleanText(filters.subject, 80).toLowerCase();
    const type = QUESTION_TYPES.includes(filters.type) ? filters.type : '';
    const search = cleanText(filters.search, 120).toLowerCase();

    return sortByUpdated(questions).filter(question => {
        if (subject && question.subject.toLowerCase() !== subject) return false;
        if (type && question.type !== type) return false;
        if (search) {
            const haystack = `${question.prompt} ${question.subject} ${question.topic}`.toLowerCase();
            if (!haystack.includes(search)) return false;
        }
        return true;
    });
}

class JsonDriver {
    constructor(file) {
        this.file = file;
        this.name = 'json';
        this.data = { questions: [], exams: [] };
        this._write = Promise.resolve();
    }

    async init() {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = {
                questions: Array.isArray(parsed.questions) ? parsed.questions : [],
                exams: Array.isArray(parsed.exams) ? parsed.exams : []
            };
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn('Could not read exam store, starting empty:', error.message);
            }
            await this.persist();
        }
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

    async listQuestions(filters) {
        return applyQuestionFilters(this.data.questions, filters);
    }

    async getQuestion(id) {
        return this.data.questions.find(question => question.id === id) || null;
    }

    async createQuestion(question) {
        const now = Date.now();
        const record = { ...question, id: makeId('q'), createdAt: now, updatedAt: now };
        this.data.questions.push(record);
        await this.persist();
        return record;
    }

    async updateQuestion(id, question) {
        const index = this.data.questions.findIndex(item => item.id === id);
        if (index === -1) throw httpError(404, 'Question not found');
        const record = { ...this.data.questions[index], ...question, id, updatedAt: Date.now() };
        this.data.questions[index] = record;
        await this.persist();
        return record;
    }

    async deleteQuestion(id) {
        const before = this.data.questions.length;
        this.data.questions = this.data.questions.filter(question => question.id !== id);
        if (this.data.questions.length === before) throw httpError(404, 'Question not found');

        let examsChanged = false;
        this.data.exams = this.data.exams.map(exam => {
            const questions = exam.questions.filter(item => item.questionId !== id);
            if (questions.length === exam.questions.length) return exam;
            examsChanged = true;
            return { ...exam, questions, updatedAt: Date.now() };
        });
        await this.persist();
        return examsChanged;
    }

    async listExams() {
        return sortByUpdated(this.data.exams);
    }

    async getExam(id) {
        return this.data.exams.find(exam => exam.id === id) || null;
    }

    async createExam(exam) {
        const now = Date.now();
        const record = { ...exam, id: makeId('e'), createdAt: now, updatedAt: now };
        this.data.exams.push(record);
        await this.persist();
        return record;
    }

    async updateExam(id, exam) {
        const index = this.data.exams.findIndex(item => item.id === id);
        if (index === -1) throw httpError(404, 'Exam not found');
        const record = { ...this.data.exams[index], ...exam, id, updatedAt: Date.now() };
        this.data.exams[index] = record;
        await this.persist();
        return record;
    }

    async deleteExam(id) {
        const before = this.data.exams.length;
        this.data.exams = this.data.exams.filter(exam => exam.id !== id);
        if (this.data.exams.length === before) throw httpError(404, 'Exam not found');
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
            CREATE TABLE IF NOT EXISTS questions (
                id VARCHAR(32) PRIMARY KEY,
                subject VARCHAR(80) NOT NULL,
                topic VARCHAR(120) NOT NULL DEFAULT '',
                type VARCHAR(20) NOT NULL,
                prompt TEXT NOT NULL,
                options JSON NOT NULL,
                correct JSON NOT NULL,
                marks INT NOT NULL DEFAULT 1,
                difficulty VARCHAR(10) NOT NULL DEFAULT 'medium',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS exams (
                id VARCHAR(32) PRIMARY KEY,
                title VARCHAR(120) NOT NULL,
                description VARCHAR(500) NOT NULL DEFAULT '',
                subject VARCHAR(80) NOT NULL DEFAULT '',
                duration_minutes INT NOT NULL DEFAULT 60,
                questions JSON NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    }

    async listQuestions(filters) {
        const [rows] = await this.pool.query('SELECT * FROM questions');
        return applyQuestionFilters(rows.map(rowToQuestion), filters);
    }

    async getQuestion(id) {
        const [rows] = await this.pool.query('SELECT * FROM questions WHERE id = ?', [id]);
        return rows.length ? rowToQuestion(rows[0]) : null;
    }

    async createQuestion(question) {
        const now = Date.now();
        const record = { ...question, id: makeId('q'), createdAt: now, updatedAt: now };
        await this.pool.query(
            `INSERT INTO questions (id, subject, topic, type, prompt, options, correct, marks, difficulty, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [record.id, record.subject, record.topic, record.type, record.prompt,
             JSON.stringify(record.options), JSON.stringify(record.correct),
             record.marks, record.difficulty, record.createdAt, record.updatedAt]
        );
        return record;
    }

    async updateQuestion(id, question) {
        const existing = await this.getQuestion(id);
        if (!existing) throw httpError(404, 'Question not found');
        const record = { ...existing, ...question, id, updatedAt: Date.now() };
        await this.pool.query(
            `UPDATE questions SET subject = ?, topic = ?, type = ?, prompt = ?, options = ?, correct = ?,
             marks = ?, difficulty = ?, updated_at = ? WHERE id = ?`,
            [record.subject, record.topic, record.type, record.prompt,
             JSON.stringify(record.options), JSON.stringify(record.correct),
             record.marks, record.difficulty, record.updatedAt, id]
        );
        return record;
    }

    async deleteQuestion(id) {
        const [result] = await this.pool.query('DELETE FROM questions WHERE id = ?', [id]);
        if (!result.affectedRows) throw httpError(404, 'Question not found');

        const [rows] = await this.pool.query('SELECT * FROM exams');
        let examsChanged = false;
        for (const row of rows) {
            const exam = rowToExam(row);
            const questions = exam.questions.filter(item => item.questionId !== id);
            if (questions.length === exam.questions.length) continue;
            examsChanged = true;
            await this.pool.query(
                'UPDATE exams SET questions = ?, updated_at = ? WHERE id = ?',
                [JSON.stringify(questions), Date.now(), exam.id]
            );
        }
        return examsChanged;
    }

    async listExams() {
        const [rows] = await this.pool.query('SELECT * FROM exams');
        return sortByUpdated(rows.map(rowToExam));
    }

    async getExam(id) {
        const [rows] = await this.pool.query('SELECT * FROM exams WHERE id = ?', [id]);
        return rows.length ? rowToExam(rows[0]) : null;
    }

    async createExam(exam) {
        const now = Date.now();
        const record = { ...exam, id: makeId('e'), createdAt: now, updatedAt: now };
        await this.pool.query(
            `INSERT INTO exams (id, title, description, subject, duration_minutes, questions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [record.id, record.title, record.description, record.subject,
             record.durationMinutes, JSON.stringify(record.questions), record.createdAt, record.updatedAt]
        );
        return record;
    }

    async updateExam(id, exam) {
        const existing = await this.getExam(id);
        if (!existing) throw httpError(404, 'Exam not found');
        const record = { ...existing, ...exam, id, updatedAt: Date.now() };
        await this.pool.query(
            `UPDATE exams SET title = ?, description = ?, subject = ?, duration_minutes = ?, questions = ?, updated_at = ?
             WHERE id = ?`,
            [record.title, record.description, record.subject, record.durationMinutes,
             JSON.stringify(record.questions), record.updatedAt, id]
        );
        return record;
    }

    async deleteExam(id) {
        const [result] = await this.pool.query('DELETE FROM exams WHERE id = ?', [id]);
        if (!result.affectedRows) throw httpError(404, 'Exam not found');
    }
}

class ExamStore {
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
                    port: clampInt(process.env.MYSQL_PORT, 1, 65535, 3306),
                    user: MYSQL_USER,
                    password: process.env.MYSQL_PASSWORD || '',
                    database: MYSQL_DATABASE
                });
                await driver.init();
                this.driver = driver;
                console.log('🗄️  Question bank using MySQL database:', MYSQL_DATABASE);
                return;
            } catch (error) {
                console.error('❌ MySQL connection failed, falling back to JSON store:', error.message);
            }
        }

        const file = process.env.EXAM_STORE_FILE || path.join(__dirname, '..', 'data', 'exams.json');
        const driver = new JsonDriver(file);
        await driver.init();
        this.driver = driver;
        console.log('🗄️  Question bank using JSON store:', file);
    }

    get storageName() {
        return this.driver ? this.driver.name : 'initializing';
    }

    async _questionLookup() {
        const questions = await this.driver.listQuestions({});
        return new Map(questions.map(question => [question.id, question]));
    }

    listQuestions(filters) {
        return this.ready.then(() => this.driver.listQuestions(filters));
    }

    async getQuestion(id) {
        await this.ready;
        const question = await this.driver.getQuestion(id);
        if (!question) throw httpError(404, 'Question not found');
        return question;
    }

    async createQuestion(input) {
        await this.ready;
        return this.driver.createQuestion(normalizeQuestion(input));
    }

    async updateQuestion(id, input) {
        await this.ready;
        const existing = await this.driver.getQuestion(id);
        if (!existing) throw httpError(404, 'Question not found');
        const merged = normalizeQuestion({ ...existing, ...input });
        return this.driver.updateQuestion(id, merged);
    }

    async deleteQuestion(id) {
        await this.ready;
        return this.driver.deleteQuestion(id);
    }

    async listSubjects() {
        await this.ready;
        const questions = await this.driver.listQuestions({});
        return [...new Set(questions.map(question => question.subject))]
            .sort((a, b) => a.localeCompare(b));
    }

    async listExams() {
        await this.ready;
        return this.driver.listExams();
    }

    async getExam(id, { resolveQuestions = false } = {}) {
        await this.ready;
        const exam = await this.driver.getExam(id);
        if (!exam) throw httpError(404, 'Exam not found');
        if (!resolveQuestions) return exam;

        const questions = await this.driver.listQuestions({});
        const lookup = new Map(questions.map(question => [question.id, question]));
        return {
            ...exam,
            questionCount: exam.questions.length,
            totalMarks: exam.questions.reduce((sum, item) => sum + item.marks, 0),
            resolvedQuestions: exam.questions
                .map(item => {
                    const question = lookup.get(item.questionId);
                    return question ? { ...question, marks: item.marks } : null;
                })
                .filter(Boolean)
        };
    }

    async createExam(input) {
        await this.ready;
        const lookup = await this._questionLookup();
        const exam = normalizeExam(input, lookup);
        return this.driver.createExam(exam);
    }

    async updateExam(id, input) {
        await this.ready;
        const existing = await this.driver.getExam(id);
        if (!existing) throw httpError(404, 'Exam not found');
        const lookup = await this._questionLookup();
        const merged = normalizeExam({ ...existing, ...input }, lookup);
        return this.driver.updateExam(id, merged);
    }

    async deleteExam(id) {
        await this.ready;
        return this.driver.deleteExam(id);
    }
}

module.exports = {
    ExamStore,
    QUESTION_TYPES,
    TRUE_FALSE_OPTIONS,
    httpError
};
