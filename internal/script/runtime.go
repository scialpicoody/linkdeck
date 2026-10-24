package script

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Script output row types.
const (
	OutputLog       = "log"
	OutputTX        = "tx"
	OutputRX        = "rx"
	OutputUnmatched = "unmatched"
	OutputError     = "error"
	OutputSystem    = "system"
)

// Run states exposed to the Scripts view.
const (
	RunQueued    = "queued"
	RunRunning   = "running"
	RunCompleted = "completed"
	RunFailed    = "failed"
	RunTimedOut  = "timed-out"
	RunCancelled = "cancelled"
)

// Script output row types exposed to the UI.
type OutputRow struct {
	RunID     string `json:"runId"`
	Script    string `json:"script"`
	Type      string `json:"type"`
	Channel   string `json:"channel"`
	Direction string `json:"direction"`
	Data      string `json:"data"`
	Line      int    `json:"line"`
	TsMillis  int64  `json:"tsMillis"`
}

// RunInfo is the stable state record for one source/file/session run.
type RunInfo struct {
	ID        string `json:"id"`
	Script    string `json:"script"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	Error     string `json:"error"`
	Line      int    `json:"line"`
	StartedMs int64  `json:"startedMs"`
	EndedMs   int64  `json:"endedMs"`
}

// SessionInfo is the UI-facing state of one long-lived script session.
type SessionInfo struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	State      string `json:"state"`
	ModifiedMs int64  `json:"modifiedMs"`
}

type runRecord struct {
	info   RunInfo
	cancel context.CancelFunc
	order  uint64
}

// SetWorkspace binds file execution to the configured script root.
func (s *ScriptService) SetWorkspace(ws *Workspace) {
	s.mu.Lock()
	s.ws = ws
	s.mu.Unlock()
}

// SetOutputHandler installs the structured script-output sink.
func (s *ScriptService) SetOutputHandler(fn func(OutputRow)) {
	s.mu.Lock()
	s.output = fn
	s.mu.Unlock()
}

// SetStatusHandler installs the run-state event sink.
func (s *ScriptService) SetStatusHandler(fn func(RunInfo)) {
	s.mu.Lock()
	s.status = fn
	s.mu.Unlock()
}

func (s *ScriptService) workspacePath(rel string) (string, error) {
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	if ws == nil {
		return "", errors.New("script workspace is not configured")
	}
	abs, err := ws.Resolve(rel)
	if err != nil {
		return "", err
	}
	if err := ws.checkPath(abs); err != nil {
		return "", err
	}
	return abs, nil
}

func (s *ScriptService) relativeScriptPath(abs string) string {
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	if ws == nil {
		return filepath.Base(abs)
	}
	rel, err := filepath.Rel(ws.Root(), abs)
	if err != nil {
		return filepath.Base(abs)
	}
	return filepath.ToSlash(rel)
}

func (s *ScriptService) emitOutput(row OutputRow) {
	s.mu.Lock()
	sink := s.output
	s.mu.Unlock()
	if sink == nil {
		return
	}
	if row.TsMillis == 0 {
		row.TsMillis = NowMillis()
	}
	sink(row)
}

func (s *ScriptService) emitStatus(info RunInfo) {
	s.mu.Lock()
	sink := s.status
	s.mu.Unlock()
	if sink != nil {
		sink(info)
	}
}

func (s *ScriptService) nextRunID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runSeq++
	return fmt.Sprintf("run-%d", s.runSeq)
}

// StartSource starts a fresh-source run and returns before execution ends.
func (s *ScriptService) StartSource(src, script string, timeoutMs int) (RunInfo, error) {
	if strings.TrimSpace(src) == "" {
		return RunInfo{}, errors.New("script source is empty")
	}
	if strings.TrimSpace(script) == "" {
		script = "source.lua"
	}
	return s.startRun("source", script, func(
		ctx context.Context,
		output func(ExecutionOutput),
	) error {
		return s.eng.RunContext(ctx, src, time.Duration(timeoutMs)*time.Millisecond, output)
	})
}

// StartFile starts a workspace-relative file run.
func (s *ScriptService) StartFile(path string, timeoutMs int) (RunInfo, error) {
	abs, err := s.workspacePath(path)
	if err != nil {
		return RunInfo{}, err
	}
	return s.startRun("file", path, func(
		ctx context.Context,
		output func(ExecutionOutput),
	) error {
		return s.eng.RunFileContext(ctx, abs, time.Duration(timeoutMs)*time.Millisecond, output)
	})
}

func (s *ScriptService) startRun(
	kind string,
	script string,
	execute func(context.Context, func(ExecutionOutput)) error,
) (RunInfo, error) {
	id := s.nextRunID()
	ctx, cancel := context.WithCancel(context.Background())
	info := RunInfo{
		ID: id, Script: script, Kind: kind, State: RunQueued, StartedMs: NowMillis(),
	}
	s.mu.Lock()
	s.runSeq++
	record := &runRecord{info: info, cancel: cancel, order: s.runSeq}
	s.runs[id] = record
	s.mu.Unlock()
	s.emitStatus(info)

	go func() {
		s.updateRun(id, func(current *RunInfo) {
			current.State = RunRunning
		})
		err := execute(ctx, func(row ExecutionOutput) {
			s.emitOutput(OutputRow{
				RunID: id, Script: script, Type: row.Type, Channel: row.Channel,
				Direction: row.Direction, Data: row.Data, Line: row.Line,
				TsMillis: row.TsMillis,
			})
		})
		s.finishRun(id, ctx, err)
	}()
	return info, nil
}

func (s *ScriptService) updateRun(id string, mutate func(*RunInfo)) {
	s.mu.Lock()
	record := s.runs[id]
	if record == nil {
		s.mu.Unlock()
		return
	}
	mutate(&record.info)
	info := record.info
	s.mu.Unlock()
	s.emitStatus(info)
}

func (s *ScriptService) finishRun(id string, ctx context.Context, err error) {
	state := RunCompleted
	line := 0
	message := ""
	if err != nil {
		state = RunFailed
		message = err.Error()
		line = ErrorLine(err)
		var runErr *RunError
		if errors.As(err, &runErr) && runErr.Timeout {
			state = RunTimedOut
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			state = RunCancelled
		}
	}

	s.mu.Lock()
	record := s.runs[id]
	if record == nil {
		s.mu.Unlock()
		return
	}
	script := record.info.Script
	record.info.State = state
	record.info.Error = message
	record.info.Line = line
	record.info.EndedMs = NowMillis()
	info := record.info
	record.cancel()
	s.pruneRunsLocked()
	s.mu.Unlock()

	if state != RunCompleted {
		s.emitOutput(OutputRow{
			RunID: id, Script: script, Type: OutputError, Direction: "local",
			Data: message, Line: line,
		})
	} else {
		duration := info.EndedMs - info.StartedMs
		s.emitOutput(OutputRow{
			RunID: id, Script: script, Type: OutputSystem, Direction: "local",
			Data: fmt.Sprintf("completed in %d ms", duration),
		})
	}
	s.emitStatus(info)
}

func (s *ScriptService) pruneRunsLocked() {
	const keep = 100
	if len(s.runs) <= keep {
		return
	}
	final := make([]*runRecord, 0, len(s.runs))
	for _, record := range s.runs {
		if record.info.State != RunQueued && record.info.State != RunRunning {
			final = append(final, record)
		}
	}
	sort.Slice(final, func(i, j int) bool { return final[i].order < final[j].order })
	for len(s.runs) > keep && len(final) > 0 {
		delete(s.runs, final[0].info.ID)
		final = final[1:]
	}
}

// CancelRun requests cancellation and returns the current state.
func (s *ScriptService) CancelRun(id string) (RunInfo, error) {
	s.mu.Lock()
	record := s.runs[id]
	if record == nil {
		s.mu.Unlock()
		return RunInfo{}, fmt.Errorf("script: unknown run %s", id)
	}
	cancel := record.cancel
	info := record.info
	s.mu.Unlock()
	cancel()
	return info, nil
}

// RunStatus returns one retained run record.
func (s *ScriptService) RunStatus(id string) (RunInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.runs[id]
	if record == nil {
		return RunInfo{}, fmt.Errorf("script: unknown run %s", id)
	}
	return record.info, nil
}

// LoadSession loads and registers a long-lived workspace script.
func (s *ScriptService) LoadSession(path string) (SessionInfo, error) {
	abs, err := s.workspacePath(path)
	if err != nil {
		return SessionInfo{}, err
	}
	session, err := s.eng.Load(abs)
	if err != nil {
		return SessionInfo{}, err
	}
	info, err := sessionInfo(path, session.Path())
	if err != nil {
		return SessionInfo{}, err
	}
	s.mu.Lock()
	s.sessions[path] = struct{}{}
	s.mu.Unlock()
	s.emitOutput(OutputRow{
		Script: path, Type: OutputSystem, Direction: "local", Data: "session loaded",
	})
	return info, nil
}

// CallSession starts a long-lived session call without blocking the UI.
// Calls use the same run state and cancellation surface as source/file runs.
func (s *ScriptService) CallSession(path, fn string, timeoutMs int) (RunInfo, error) {
	abs, err := s.workspacePath(path)
	if err != nil {
		return RunInfo{}, err
	}
	if strings.TrimSpace(fn) == "" {
		return RunInfo{}, errors.New("session function name is required")
	}
	return s.startRun("session", path, func(
		ctx context.Context,
		output func(ExecutionOutput),
	) error {
		session, err := s.eng.Load(abs)
		if err != nil {
			return err
		}
		values, err := session.CallContext(
			ctx, fn, time.Duration(timeoutMs)*time.Millisecond, output,
		)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(values)
		if err != nil {
			return err
		}
		output(ExecutionOutput{
			Type: OutputSystem, Direction: "local", Data: "returned " + string(raw),
		})
		return nil
	})
}

// CloseSession closes one long-lived session if it is live.
func (s *ScriptService) CloseSession(path string) error {
	abs, err := s.workspacePath(path)
	if err != nil {
		return err
	}
	var target *Session
	for _, session := range s.eng.sessionsSnapshot() {
		if session.Path() == abs {
			target = session
			break
		}
	}
	if target == nil {
		return fmt.Errorf("script: session %s is not loaded", path)
	}
	if err := target.Close(); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.sessions, path)
	s.mu.Unlock()
	s.emitOutput(OutputRow{
		Script: path, Type: OutputSystem, Direction: "local", Data: "session closed",
	})
	return nil
}

// Sessions lists live long-lived sessions in deterministic path order.
func (s *ScriptService) Sessions() []SessionInfo {
	s.mu.Lock()
	paths := make([]string, 0, len(s.sessions))
	for path := range s.sessions {
		paths = append(paths, path)
	}
	s.mu.Unlock()
	sort.Strings(paths)
	out := make([]SessionInfo, 0, len(paths))
	for _, path := range paths {
		abs, err := s.workspacePath(path)
		if err != nil {
			continue
		}
		info, err := sessionInfo(path, abs)
		if err != nil {
			continue
		}
		out = append(out, info)
	}
	return out
}

func sessionInfo(path, abs string) (SessionInfo, error) {
	stat, err := os.Stat(abs)
	if err != nil {
		return SessionInfo{}, err
	}
	return SessionInfo{
		Path: path, Name: filepath.Base(path), State: "loaded", ModifiedMs: stat.ModTime().UnixMilli(),
	}, nil
}
