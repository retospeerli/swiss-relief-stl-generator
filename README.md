# Swiss Relief STL Generator

Statische Web-App, die aus **swissALTI³D** von swisstopo druckbare Gelände-STLs erzeugt.

## Start

Es gibt keinen Build-Schritt.

1. Alle Dateien in ein GitHub-Repository kopieren.
2. GitHub → **Settings → Pages**.
3. **Deploy from a branch** wählen.
4. Branch `main`, Ordner `/ (root)` auswählen.
5. Die erzeugte GitHub-Pages-Adresse öffnen.

Für einen lokalen Test muss die App über HTTP laufen; `index.html` nicht nur als `file://` öffnen.

Beispiel mit Python:

```bash
python -m http.server 8000
```

Dann `http://localhost:8000` öffnen.

## Bedienung

1. Auf der Karte mit dem Rechteck-Werkzeug einen Ausschnitt markieren.
2. Datenquelle, Modellbreite, Basisdicke, Höhenüberhöhung und Mesh-Auflösung wählen.
3. **Relief aus swisstopo laden** anklicken.
4. 3D-Vorschau kontrollieren.
5. **STL herunterladen**.

## Funktionsweise

- Kartenhintergrund: swisstopo WMTS.
- Katalog: `data.geo.admin.ch` STAC API v1.
- Collection: `ch.swisstopo.swissalti3d`.
- Pro 1-km-Kachel wird der neueste verfügbare Jahrgang gewählt.
- Die gewünschte Auflösung wird über `eo:gsd` (0.5 oder 2 m) ausgewählt.
- GeoTIFFs werden direkt im Browser mit GeoTIFF.js gelesen.
- Das Zielraster wird an die tatsächliche Druckauflösung angepasst.
- Das STL ist geschlossen: Geländeoberfläche, Seitenwände und flacher Boden.

## Grenzen dieser ersten Version

- Ausschnitte sind auf ca. 80 × 80 km begrenzt.
- Seen werden noch nicht automatisch planarisiert.
- Noch keine automatische Aufteilung in mehrere Druckplatten.
- Noch keine Beschriftungen, Magnete oder Nut/Feder-Verbindungen.
- Bei sehr hoher Mesh-Auflösung kann eine STL deutlich über 100 MB gross werden.

## Externe Browser-Bibliotheken

Die App lädt Leaflet, Leaflet Draw, GeoTIFF.js, proj4js und Three.js von jsDelivr. Der eigene App-Code benötigt keinen Server und keine API-Schlüssel.

## Daten / Lizenz

Geländedaten und Karten: © swisstopo. Es gelten die Nutzungsbedingungen der Bundesgeodaten-Infrastruktur.
