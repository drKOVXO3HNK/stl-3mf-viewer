# STL / 3MF Viewer

Просмотрщик 3D-моделей (STL и 3MF) в браузере на Three.js.

## Запуск локально
Важно: не открывай `index.html` как `file://` — в таком режиме часть браузеров блокирует загрузчики модулей.

```bash
python -m http.server 8080
```

Открой: `http://localhost:8080`

## GitHub Pages
В репе настроен workflow `.github/workflows/pages.yml`.
После пуша в `main` можно включить:

1. `Settings` → `Pages`
2. Source: `GitHub Actions`

После деплоя сайт будет доступен на Pages URL репозитория.

## Функции
- Выбор файла (`.stl`, `.3mf`)
- Drag & Drop
- Орбитальная камера (вращение/масштаб)
- Сброс вида
- Wireframe режим
