// Registration and sign-in page behavior
(function () {
    'use strict';

    const el = id => document.getElementById(id);
    const mode = document.body.dataset.authMode || 'login';

    function showError(message) {
        const box = el('authError');
        if (!box) return;
        box.textContent = message;
        box.classList.toggle('hidden', !message);
    }

    function setBusy(busy) {
        const button = el('authSubmit');
        if (!button) return;
        button.disabled = busy;
        button.classList.toggle('busy', busy);
    }

    function nextUrl() {
        const next = new URLSearchParams(window.location.search).get('next');
        if (!next) return '/proctor.html';
        // Only allow same-site paths
        if (!next.startsWith('/') || next.startsWith('//')) return '/proctor.html';
        return next;
    }

    async function post(url, body) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let payload = null;
        try {
            payload = await response.json();
        } catch (error) {
            payload = null;
        }
        if (!response.ok || !payload || payload.success === false) {
            throw new Error((payload && payload.error) || `Request failed (${response.status})`);
        }
        return payload;
    }

    async function loadReferrals() {
        const select = el('referral');
        if (!select) return;
        try {
            const response = await fetch('/api/auth/options');
            const data = await response.json();
            (data.referrals || []).forEach(option => {
                const node = document.createElement('option');
                node.value = option;
                node.textContent = option;
                select.appendChild(node);
            });
        } catch (error) {
            ['Search engine', 'Social media', 'Referral from a colleague',
                'Education conference or event', 'Direct outreach from Verot', 'Other'
            ].forEach(option => {
                const node = document.createElement('option');
                node.value = option;
                node.textContent = option;
                select.appendChild(node);
            });
        }
    }

    function bindPasswordToggles() {
        document.querySelectorAll('[data-toggle-password]').forEach(button => {
            button.addEventListener('click', () => {
                const input = el(button.dataset.togglePassword);
                if (!input) return;
                const showing = input.type === 'text';
                input.type = showing ? 'password' : 'text';
                button.innerHTML = showing ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
            });
        });
    }

    async function handleLogin(event) {
        event.preventDefault();
        showError('');
        const email = el('authEmail').value.trim();
        const password = el('authPassword').value;
        if (!email || !password) {
            showError('Enter your email and password');
            return;
        }
        setBusy(true);
        try {
            await post('/api/auth/login', { email, password });
            window.location.href = nextUrl();
        } catch (error) {
            showError(error.message);
            setBusy(false);
        }
    }

    async function handleRegister(event) {
        event.preventDefault();
        showError('');
        const companyName = el('companyName').value.trim();
        const adminName = el('adminName').value.trim();
        const email = el('authEmail').value.trim();
        const contact = el('contact').value.trim();
        const address = el('address').value.trim();
        const referral = el('referral').value;
        const password = el('authPassword').value;
        const confirm = el('confirmPassword').value;

        if (!companyName || !email || !contact || !address || !referral) {
            showError('Fill in the institution name, email, contact, address, and referral option');
            return;
        }
        if (password.length < 8) {
            showError('Password must be at least 8 characters');
            return;
        }
        if (password !== confirm) {
            showError('Passwords do not match');
            return;
        }

        setBusy(true);
        try {
            await post('/api/auth/register', {
                companyName,
                adminName,
                email,
                contact,
                address,
                referral,
                password
            });
            window.location.href = '/proctor.html?welcome=1';
        } catch (error) {
            showError(error.message);
            setBusy(false);
        }
    }

    function init() {
        bindPasswordToggles();
        if (mode === 'register') {
            loadReferrals();
            el('authForm')?.addEventListener('submit', handleRegister);
            return;
        }
        el('authForm')?.addEventListener('submit', handleLogin);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
