package script

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// MaxWorkspaceScriptBytes bounds one read/edit operation.
	MaxWorkspaceScriptBytes = 2 << 20
	// MaxWorkspaceFiles keeps a stray directory scan from flooding the UI.
	MaxWorkspaceFiles = 1000
)

// ErrWorkspaceConflict reports that a file changed after it was opened.
var ErrWorkspaceConflict = errors.New("script workspace: file changed on disk")

// WorkspaceFile is one Lua file exposed to the script library.
type WorkspaceFile struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedMs int64  `json:"modifiedMs"`
}

// WorkspaceDocument is one source file plus the revision used for
// optimistic-concurrency checks when saving.
type WorkspaceDocument struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Source     string `json:"source"`
	Size       int64  `json:"size"`
	ModifiedMs int64  `json:"modifiedMs"`
	Revision   string `json:"revision"`
}

// Workspace owns the script directory. Paths crossing the bindings boundary
// are workspace-relative; the workspace resolves them without allowing a
// traversal outside its root.
type Workspace struct {
	root string
}

// DefaultWorkspaceRoot returns LINK_DECK_SCRIPTS_DIR when set, otherwise the
// per-user config directory's scripts/ folder. The directory is created on
// first list/read/create operation.
func DefaultWorkspaceRoot() (string, error) {
	if root := strings.TrimSpace(os.Getenv("LINK_DECK_SCRIPTS_DIR")); root != "" {
		return filepath.Abs(root)
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("script workspace: user config dir: %w", err)
	}
	return filepath.Join(dir, "linkdeck", "scripts"), nil
}

// OpenWorkspace creates and validates the workspace directory.
func OpenWorkspace(root string) (*Workspace, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("script workspace: root is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("script workspace: resolve root: %w", err)
	}
	abs = filepath.Clean(abs)
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("script workspace: create root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("script workspace: resolve root links: %w", err)
	}
	return &Workspace{root: filepath.Clean(resolved)}, nil
}

// Root returns the absolute workspace directory.
func (w *Workspace) Root() string { return w.root }

// List returns Lua files sorted by workspace-relative path.
func (w *Workspace) List() ([]WorkspaceFile, error) {
	out := make([]WorkspaceFile, 0)
	err := filepath.WalkDir(w.root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == w.root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".lua") {
			return nil
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		out = append(out, WorkspaceFile{
			Path:       filepath.ToSlash(rel),
			Name:       entry.Name(),
			Size:       info.Size(),
			ModifiedMs: info.ModTime().UnixMilli(),
		})
		if len(out) > MaxWorkspaceFiles {
			return errors.New("script workspace: too many Lua files")
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("script workspace: list: %w", err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// Read returns one workspace-relative Lua source file.
func (w *Workspace) Read(rel string) (string, error) {
	doc, err := w.ReadDocument(rel)
	if err != nil {
		return "", err
	}
	return doc.Source, nil
}

// ReadDocument returns one source file and its revision. Callers pass the
// revision back to WriteChecked so an external edit cannot be overwritten
// silently.
func (w *Workspace) ReadDocument(rel string) (WorkspaceDocument, error) {
	path, err := w.Resolve(rel)
	if err != nil {
		return WorkspaceDocument{}, err
	}
	if err := w.checkPath(path); err != nil {
		return WorkspaceDocument{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return WorkspaceDocument{}, fmt.Errorf("script workspace: read %s: %w", rel, err)
	}
	if !info.Mode().IsRegular() {
		return WorkspaceDocument{}, fmt.Errorf("script workspace: %s is not a regular file", rel)
	}
	if info.Size() > MaxWorkspaceScriptBytes {
		return WorkspaceDocument{}, fmt.Errorf("script workspace: %s exceeds %d bytes", rel, MaxWorkspaceScriptBytes)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return WorkspaceDocument{}, fmt.Errorf("script workspace: read %s: %w", rel, err)
	}
	if len(raw) > MaxWorkspaceScriptBytes {
		return WorkspaceDocument{}, fmt.Errorf("script workspace: %s exceeds %d bytes", rel, MaxWorkspaceScriptBytes)
	}
	return WorkspaceDocument{
		Path:       filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel))),
		Name:       filepath.Base(path),
		Source:     string(raw),
		Size:       int64(len(raw)),
		ModifiedMs: info.ModTime().UnixMilli(),
		Revision:   revisionOf(raw),
	}, nil
}

// Write atomically replaces one workspace-relative Lua source file.
func (w *Workspace) Write(rel, source string) error {
	path, err := w.Resolve(rel)
	if err != nil {
		return err
	}
	if len(source) > MaxWorkspaceScriptBytes {
		return fmt.Errorf("script workspace: source exceeds %d bytes", MaxWorkspaceScriptBytes)
	}
	if err := w.checkPath(filepath.Dir(path)); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("script workspace: create parent: %w", err)
	}
	if err := w.checkPath(path); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("script workspace: %s is not a regular file", rel)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("script workspace: stat %s: %w", rel, err)
	}
	return w.writeAtomic(path, source, true)
}

// WriteChecked atomically replaces a file only when its current content
// still matches expectedRevision. Creation through this path is rejected;
// use Create so collisions stay explicit.
func (w *Workspace) WriteChecked(rel, source, expectedRevision string) (WorkspaceDocument, error) {
	if strings.TrimSpace(expectedRevision) == "" {
		return WorkspaceDocument{}, errors.New("script workspace: revision is required")
	}
	if len(source) > MaxWorkspaceScriptBytes {
		return WorkspaceDocument{}, fmt.Errorf(
			"script workspace: source exceeds %d bytes",
			MaxWorkspaceScriptBytes,
		)
	}
	path, err := w.Resolve(rel)
	if err != nil {
		return WorkspaceDocument{}, err
	}
	current, err := w.ReadDocument(rel)
	if err != nil {
		return WorkspaceDocument{}, err
	}
	if current.Revision != expectedRevision {
		return WorkspaceDocument{}, ErrWorkspaceConflict
	}
	if err := w.writeAtomic(path, source, true); err != nil {
		return WorkspaceDocument{}, err
	}
	return w.ReadDocument(rel)
}

func (w *Workspace) writeAtomic(path, source string, replace bool) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".lua-*.tmp")
	if err != nil {
		return fmt.Errorf("script workspace: temp: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(source); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("script workspace: write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("script workspace: close: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("script workspace: chmod: %w", err)
	}
	if replace {
		err = os.Rename(tmpName, path)
	} else {
		// Link is atomic and fails with EEXIST instead of replacing a file
		// created between the caller's check and this write.
		err = os.Link(tmpName, path)
	}
	if err != nil {
		_ = os.Remove(tmpName)
		if !replace && errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("script workspace: %s already exists", filepath.Base(path))
		}
		return fmt.Errorf("script workspace: write %s: %w", filepath.Base(path), err)
	}
	if !replace {
		if err := os.Remove(tmpName); err != nil {
			return fmt.Errorf("script workspace: cleanup temp: %w", err)
		}
	}
	return nil
}

// Create adds a new top-level Lua file and returns its listing entry.
func (w *Workspace) Create(name string) (WorkspaceFile, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return WorkspaceFile{}, errors.New("script workspace: file name is empty")
	}
	if filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
		return WorkspaceFile{}, errors.New("script workspace: file name must not contain a path")
	}
	if !strings.EqualFold(filepath.Ext(name), ".lua") {
		name += ".lua"
	}
	if _, err := w.Resolve(name); err != nil {
		return WorkspaceFile{}, err
	}
	source := "-- " + strings.TrimSuffix(name, filepath.Ext(name)) + "\nlog(\"ready\")\n"
	path, err := w.Resolve(name)
	if err != nil {
		return WorkspaceFile{}, err
	}
	if len(source) > MaxWorkspaceScriptBytes {
		return WorkspaceFile{}, fmt.Errorf("script workspace: source exceeds %d bytes", MaxWorkspaceScriptBytes)
	}
	if err := w.checkPath(path); err != nil {
		return WorkspaceFile{}, err
	}
	if err := w.writeAtomic(path, source, false); err != nil {
		return WorkspaceFile{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return WorkspaceFile{}, err
	}
	return WorkspaceFile{
		Path:       filepath.ToSlash(name),
		Name:       name,
		Size:       info.Size(),
		ModifiedMs: info.ModTime().UnixMilli(),
	}, nil
}

// Resolve maps a clean workspace-relative path to an absolute file path.
func (w *Workspace) Resolve(rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", errors.New("script workspace: path is empty")
	}
	if filepath.IsAbs(rel) {
		return "", errors.New("script workspace: absolute paths are not accepted")
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("script workspace: path escapes the workspace")
	}
	if !strings.EqualFold(filepath.Ext(clean), ".lua") {
		return "", errors.New("script workspace: path must end in .lua")
	}
	full := filepath.Join(w.root, clean)
	within, err := filepath.Rel(w.root, full)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return "", errors.New("script workspace: path escapes the workspace")
	}
	return full, nil
}

// checkPath rejects symlinked path components between the workspace root
// and path. WalkDir skips links for listing; direct read/write calls still
// need this explicit guard because os.ReadFile and os.Rename follow them.
func (w *Workspace) checkPath(path string) error {
	rel, err := filepath.Rel(w.root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("script workspace: path escapes the workspace")
	}
	current := w.root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("script workspace: inspect %s: %w", part, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("script workspace: symlinks are not allowed: %s", part)
		}
	}
	return nil
}

func revisionOf(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
