package script

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func openTestWorkspace(t *testing.T) *Workspace {
	t.Helper()
	ws, err := OpenWorkspace(t.TempDir())
	require.NoError(t, err)
	return ws
}

func TestWorkspaceCreateReadWriteList(t *testing.T) {
	ws := openTestWorkspace(t)

	created, err := ws.Create("probe")
	require.NoError(t, err)
	assert.Equal(t, "probe.lua", created.Path)
	assert.Equal(t, "probe.lua", created.Name)
	assert.FileExists(t, filepath.Join(ws.Root(), "probe.lua"))

	source := "log(\"updated\")\n"
	require.NoError(t, ws.Write("nested/check.lua", source))
	got, err := ws.Read("nested/check.lua")
	require.NoError(t, err)
	assert.Equal(t, source, got)

	files, err := ws.List()
	require.NoError(t, err)
	require.Len(t, files, 2)
	assert.Equal(t, "nested/check.lua", files[0].Path)
	assert.Equal(t, "probe.lua", files[1].Path)
}

func TestWorkspaceReadDocumentAndCheckedWrite(t *testing.T) {
	ws := openTestWorkspace(t)
	created, err := ws.Create("checked")
	require.NoError(t, err)

	doc, err := ws.ReadDocument(created.Path)
	require.NoError(t, err)
	assert.Equal(t, created.Path, doc.Path)
	assert.NotEmpty(t, doc.Revision)
	assert.Contains(t, doc.Source, "log(\"ready\")")

	updated, err := ws.WriteChecked(doc.Path, "return 42\n", doc.Revision)
	require.NoError(t, err)
	assert.Equal(t, "return 42\n", updated.Source)
	assert.NotEqual(t, doc.Revision, updated.Revision)
}

func TestWorkspaceCheckedWriteRejectsExternalChange(t *testing.T) {
	ws := openTestWorkspace(t)
	created, err := ws.Create("conflict")
	require.NoError(t, err)
	doc, err := ws.ReadDocument(created.Path)
	require.NoError(t, err)

	path := filepath.Join(ws.Root(), created.Path)
	require.NoError(t, os.WriteFile(path, []byte("return \"external\"\n"), 0o644))

	_, err = ws.WriteChecked(created.Path, "return \"mine\"\n", doc.Revision)
	require.ErrorIs(t, err, ErrWorkspaceConflict)
	source, err := ws.Read(created.Path)
	require.NoError(t, err)
	assert.Equal(t, "return \"external\"\n", source)

	_, err = ws.WriteChecked("missing.lua", "return true\n", doc.Revision)
	require.Error(t, err)
}

func TestWorkspaceCreateDoesNotOverwrite(t *testing.T) {
	ws := openTestWorkspace(t)
	_, err := ws.Create("existing.lua")
	require.NoError(t, err)
	require.NoError(t, ws.Write("existing.lua", "return 42\n"))

	_, err = ws.Create("existing")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")

	source, err := ws.Read("existing.lua")
	require.NoError(t, err)
	assert.Equal(t, "return 42\n", source)
}

func TestWorkspaceRejectsUnsafePaths(t *testing.T) {
	ws := openTestWorkspace(t)

	for _, name := range []string{"", "../escape", "nested/name.lua", `nested\name.lua`} {
		_, err := ws.Create(name)
		assert.Error(t, err, "Create(%q)", name)
	}
	for _, path := range []string{"", "../escape.lua", "/tmp/escape.lua", "file.txt"} {
		_, err := ws.Read(path)
		assert.Error(t, err, "Read(%q)", path)
	}
}

func TestWorkspaceSkipsAndRejectsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink behavior requires extra privileges on Windows")
	}

	ws := openTestWorkspace(t)
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.lua"), []byte("secret"), 0o644))
	require.NoError(t, os.Symlink(filepath.Join(outside, "secret.lua"), filepath.Join(ws.Root(), "linked.lua")))
	require.NoError(t, os.Symlink(outside, filepath.Join(ws.Root(), "linked-dir")))

	files, err := ws.List()
	require.NoError(t, err)
	assert.Empty(t, files)

	_, err = ws.Read("linked.lua")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "symlink")

	err = ws.Write("linked-dir/new.lua", "log(\"escape\")\n")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "symlink")
	_, statErr := os.Stat(filepath.Join(outside, "new.lua"))
	assert.ErrorIs(t, statErr, os.ErrNotExist)
}

func TestWorkspaceEnforcesFileSizeLimit(t *testing.T) {
	ws := openTestWorkspace(t)
	tooLarge := strings.Repeat("x", MaxWorkspaceScriptBytes+1)

	err := ws.Write("large.lua", tooLarge)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds")

	require.NoError(t, os.WriteFile(filepath.Join(ws.Root(), "large.lua"), []byte(tooLarge), 0o644))
	_, err = ws.Read("large.lua")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exceeds")
}

func TestWorkspaceEnforcesFileCountLimit(t *testing.T) {
	ws := openTestWorkspace(t)
	for i := 0; i <= MaxWorkspaceFiles; i++ {
		name := fmt.Sprintf("script-%04d.lua", i)
		require.NoError(t, os.WriteFile(filepath.Join(ws.Root(), name), []byte("return true\n"), 0o644))
	}

	_, err := ws.List()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "too many")
}

func TestDefaultWorkspaceRootOverride(t *testing.T) {
	root := filepath.Join(t.TempDir(), "scripts")
	t.Setenv("LINK_DECK_SCRIPTS_DIR", root)

	got, err := DefaultWorkspaceRoot()
	require.NoError(t, err)
	abs, err := filepath.Abs(root)
	require.NoError(t, err)
	assert.Equal(t, filepath.Clean(abs), got)
}
