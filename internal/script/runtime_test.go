package script

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type runtimeEvents struct {
	output chan OutputRow
	status chan RunInfo
}

func newRuntimeService(t *testing.T) (*ScriptService, *Workspace, *runtimeEvents) {
	t.Helper()
	ws := openTestWorkspace(t)
	eng := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	svc := NewScriptService(eng)
	svc.SetWorkspace(ws)
	events := &runtimeEvents{
		output: make(chan OutputRow, 128),
		status: make(chan RunInfo, 128),
	}
	svc.SetOutputHandler(func(row OutputRow) { events.output <- row })
	svc.SetStatusHandler(func(info RunInfo) { events.status <- info })
	t.Cleanup(svc.Close)
	return svc, ws, events
}

func waitRunState(t *testing.T, events *runtimeEvents, id string, want string) RunInfo {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case info := <-events.status:
			if info.ID == id && info.State == want {
				return info
			}
		case <-deadline:
			t.Fatalf("timed out waiting for run %s state %s", id, want)
		}
	}
}

func collectRun(t *testing.T, events *runtimeEvents, id string) (RunInfo, []OutputRow) {
	t.Helper()
	var rows []OutputRow
	deadline := time.After(5 * time.Second)
	for {
		select {
		case row := <-events.output:
			if row.RunID == id {
				rows = append(rows, row)
			}
		case info := <-events.status:
			if info.ID == id && info.State != RunQueued && info.State != RunRunning {
				return info, rows
			}
		case <-deadline:
			t.Fatalf("timed out waiting for run %s to finish", id)
		}
	}
}

func TestScriptServiceRunOutputAndErrorLine(t *testing.T) {
	svc, _, events := newRuntimeService(t)
	info, err := svc.StartSource("local x = 1\nlog(\"hello\")\nerror(\"boom\")\n", "sample.lua", 2000)
	require.NoError(t, err)
	final, rows := collectRun(t, events, info.ID)
	assert.Equal(t, RunFailed, final.State)
	assert.Equal(t, 3, final.Line)
	assert.Contains(t, final.Error, "boom")
	assert.Contains(t, outputData(rows, OutputLog), "hello")
	assert.Contains(t, outputData(rows, OutputError), "boom")
}

func TestScriptServiceOutputRowsAndFileValidation(t *testing.T) {
	svc, ws, events := newRuntimeService(t)
	path := "probe.lua"
	require.NoError(t, ws.Write(path, "log(\"from-file\")\n"))

	_, err := svc.StartFile("../escape.lua", 1000)
	require.Error(t, err)

	info, err := svc.StartFile(path, 2000)
	require.NoError(t, err)
	_, rows := collectRun(t, events, info.ID)
	assert.Contains(t, outputData(rows, OutputLog), "from-file")
}

func TestScriptServiceCancellation(t *testing.T) {
	svc, _, events := newRuntimeService(t)
	info, err := svc.StartSource("while true do end", "spin.lua", 30_000)
	require.NoError(t, err)
	waitRunState(t, events, info.ID, RunRunning)
	_, err = svc.CancelRun(info.ID)
	require.NoError(t, err)
	final := waitRunState(t, events, info.ID, RunCancelled)
	assert.Equal(t, RunCancelled, final.State)
}

func TestScriptServiceTimeout(t *testing.T) {
	svc, _, events := newRuntimeService(t)
	info, err := svc.StartSource("while true do end", "spin.lua", 50)
	require.NoError(t, err)
	final := waitRunState(t, events, info.ID, RunTimedOut)
	assert.Equal(t, RunTimedOut, final.State)
}

func TestScriptServiceSessionLifecycle(t *testing.T) {
	svc, ws, events := newRuntimeService(t)
	path := "session.lua"
	require.NoError(t, ws.Write(path, `
n = 0
function bump()
  n = n + 1
  return n
end
`))

	loaded, err := svc.LoadSession(path)
	require.NoError(t, err)
	assert.Equal(t, "loaded", loaded.State)
	assert.Len(t, svc.Sessions(), 1)

	info, err := svc.CallSession(path, "bump", 2000)
	require.NoError(t, err)
	waitRunState(t, events, info.ID, RunCompleted)

	require.NoError(t, svc.CloseSession(path))
	assert.Empty(t, svc.Sessions())
	require.Error(t, svc.CloseSession(path))
}

func TestScriptServiceUnmatchedOutputIsScopedToRunTarget(t *testing.T) {
	svc, _, events := newRuntimeService(t)
	info, err := svc.StartSource(`
local h = assert(serial.open("target"))
local data, derr = expect(h, "READY", {timeout_ms = 80})
assert(data == nil and derr == "timeout")
`, "scoped.lua", 1000)
	require.NoError(t, err)
	waitRunState(t, events, info.ID, RunRunning)
	time.Sleep(10 * time.Millisecond)
	svc.Feed(NewRxFrame("unrelated", []byte("NOISE")))
	waitRunState(t, events, info.ID, RunCompleted)

	close(events.output)
	for row := range events.output {
		assert.False(
			t,
			row.Type == OutputUnmatched && strings.Contains(row.Channel, "unrelated"),
			"unrelated monitor traffic reached script output: %+v",
			row,
		)
	}
}

func outputData(rows []OutputRow, kind string) string {
	var parts []string
	for _, row := range rows {
		if row.Type == kind {
			parts = append(parts, row.Data)
		}
	}
	return strings.Join(parts, "\n")
}
