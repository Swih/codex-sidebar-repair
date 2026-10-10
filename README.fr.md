# Réparer le classement des projets dans Codex

[English documentation](README.md)

Un utilitaire **non officiel pour Windows**, destiné à un cas précis : les projets locaux existent encore dans la base de Codex, mais leur regroupement dans la barre de gauche ou leurs conversations rattachées ont disparu.

Il s'agit d'un contournement indépendant, pas d'un outil OpenAI ni d'une procédure officielle. Les formats internes peuvent changer. Le mécanisme initial a été vérifié sur Windows avec Codex desktop 26.1007.2314.0 ; les autres versions et systèmes ne sont pas vérifiés.

## Prérequis

- Windows et [Node.js 24 ou plus récent](https://nodejs.org/en/download).
- Les fichiers `.codex-global-state.json` et `state_5.sqlite` doivent encore exister dans le dossier de configuration de Codex.
- Les tables `projects`, `project_roots`, `project_idempotency_keys` et `threads` doivent être présentes dans la base.

Aucune dépendance à installer, aucun droit administrateur et aucune connexion à un compte ne sont nécessaires.

## Utilisation

Télécharger le dépôt avec **Code → Download ZIP**, extraire l'archive, puis ouvrir un terminal dans ce dossier.

1. Voir l'aperçu, sans modifier aucun fichier :

   ```powershell
   node repair-sidebar.cjs
   ```

2. Quitter complètement Codex, y compris ses processus en arrière-plan. Fermer aussi ChatGPT s'il est ouvert : la vérification bloque les deux noms d'application par précaution.
3. Appliquer :

   ```powershell
   node repair-sidebar.cjs --apply
   ```

4. Rouvrir Codex. L'application peut synchroniser les rattachements restaurés au démarrage. Si les projets restent cachés, vérifier que la barre latérale regroupe les conversations par projet.

Les fichiers `Preview.cmd` et `Repair.cmd` permettent aussi de lancer ces deux étapes par double-clic, si Node est accessible dans le PATH.

Le dossier utilisé est celui de `CODEX_HOME` si cette variable existe, sinon `.codex` dans le dossier personnel. Pour un emplacement différent :

```powershell
node repair-sidebar.cjs --codex-home "D:\Example\CodexHome"
node repair-sidebar.cjs --codex-home "D:\Example\CodexHome" --apply
```

## Fonctionnement et limites

L'outil reconstruit le cache des projets à partir de la base existante. Il préserve les rattachements déjà enregistrés, les conversations explicitement sans projet, l'ordre existant et les autres réglages.

Il utilise d'abord le projet indiqué dans la base, sinon le dossier de projet correspondant le plus précisément. Les cas ambigus restent inchangés. Seules les sources de conversations connues `exec` et `vscode` sont traitées ; les sous-agents et sources inconnues sont ignorés.

Avant toute modification, il sauvegarde le fichier original intégralement, vérifie que Codex est fermé et que le fichier n'a pas changé, puis remplace et vérifie la configuration. La base SQLite est ouverte en lecture seule. Aucun appel réseau n'est effectué. L'aperçu affiche uniquement des nombres.

Il ne récupère pas les projets supprimés ni les messages perdus. Un rattachement déduit d'un dossier peut différer d'un ancien choix manuel ; les choix encore enregistrés sont conservés. Une nouvelle exécution ne duplique pas les entrées. Un format de migration inconnu ou une table manquante bloque la réparation.

## Annuler et préserver ses données

Après réparation, l'outil affiche le chemin d'une sauvegarde dans `sidebar-repair-backups`, à l'intérieur du dossier de configuration de Codex. Pour revenir au fichier local précédent, fermer complètement Codex, copier cette sauvegarde à la place de `.codex-global-state.json`, puis rouvrir l'application. Les rattachements déjà synchronisés par Codex dans sa base peuvent rester présents.

La configuration, la base, les sauvegardes, les chemins et les métadonnées de conversations restent sur l'ordinateur. **Ne jamais les publier dans ce dépôt ou dans une issue.** Les sauvegardes contiennent des données privées. Pour signaler un souci, fournir uniquement les nombres de l'aperçu, une erreur anonymisée et les versions de Windows, Node et Codex. Tous les exemples et tests du dépôt sont fictifs.

## Tests

```powershell
npm test
```

Les tests utilisent des bases temporaires fictives et ne lisent pas le profil Codex personnel. Aucun `npm install` n'est nécessaire.

Licence MIT.
