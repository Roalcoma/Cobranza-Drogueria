(function() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);

    window.toggleTheme = function() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        const icon = document.getElementById('themeIcon');
        if (icon) icon.className = 'bi bi-' + (next === 'dark' ? 'sun' : 'moon-stars');
    };

    document.addEventListener('DOMContentLoaded', function() {
        const icon = document.getElementById('themeIcon');
        if (icon) icon.className = 'bi bi-' + (saved === 'dark' ? 'sun' : 'moon-stars');
    });
})();
