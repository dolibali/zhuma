import { useState, type DragEvent } from 'react';
import type { Participant, Project, WorkTask } from '@zhuma/agent-core';
import type { TaskProgressState } from '../execution/useTaskProgress.js';
import { TaskProgressSummary } from '../execution/TaskProgressSummary.js';
import {
  boardDragDecision,
  boardReviewRequired,
  taskBoardColumn,
  taskBoardColumns,
  type TaskBoardColumn,
} from './task-board.js';

const BOARD_TASK_MIME = 'application/x-zhuma-board-task';

export function TaskBoard({
  tasks,
  projects,
  participants,
  progress,
  confirmed,
  openTask,
  onMoveTask,
}: {
  tasks: readonly WorkTask[];
  projects: readonly Project[];
  participants: readonly Participant[];
  progress(taskId: string): TaskProgressState | undefined;
  confirmed(taskId: string): boolean;
  openTask(taskId: string): void;
  /** Called when a drop is allowed; should persist the stage change. Return false to snap back. */
  onMoveTask?(
    taskId: string,
    from: TaskBoardColumn,
    to: TaskBoardColumn,
  ): boolean | void | Promise<boolean | void>;
}) {
  const [notice, setNotice] = useState<string>();
  const [draggingId, setDraggingId] = useState<string>();
  const [overColumn, setOverColumn] = useState<TaskBoardColumn>();
  /** Session placements for allowed drops until authoritative facts catch up. */
  const [placements, setPlacements] = useState<Readonly<Record<string, TaskBoardColumn>>>({});

  const rows = tasks.map((task) => ({ task, progress: progress(task.id) }));

  function naturalColumn(taskId: string): TaskBoardColumn | undefined {
    const row = rows.find((item) => item.task.id === taskId);
    if (!row) return undefined;
    return taskBoardColumn(row.task, confirmed(row.task.id), row.progress);
  }

  function columnOf(taskId: string): TaskBoardColumn | undefined {
    const natural = naturalColumn(taskId);
    if (!natural) return undefined;
    const placed = placements[taskId];
    // Drop stale overrides once facts already match the placement.
    if (placed && placed === natural) return natural;
    return placed ?? natural;
  }

  function rejectMove(target: TaskBoardColumn) {
    const label = taskBoardColumns.find((column) => column.id === target)?.label ?? target;
    setNotice(
      `不能拖到「${label}」：看板阶段来自计划确认与执行／评审事实，拖列会绕过评审。卡片已回到原列。`,
    );
    setOverColumn(undefined);
    setDraggingId(undefined);
  }

  function onCardDragStart(event: DragEvent<HTMLButtonElement>, taskId: string) {
    event.dataTransfer.setData(BOARD_TASK_MIME, taskId);
    event.dataTransfer.setData('text/plain', taskId);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(taskId);
    setNotice(undefined);
  }

  function onColumnDragOver(event: DragEvent<HTMLElement>, columnId: TaskBoardColumn) {
    if (![...event.dataTransfer.types].includes(BOARD_TASK_MIME) && !draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setOverColumn(columnId);
  }

  async function onColumnDrop(event: DragEvent<HTMLElement>, columnId: TaskBoardColumn) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData(BOARD_TASK_MIME) || draggingId;
    const from = taskId ? columnOf(taskId) : undefined;
    setOverColumn(undefined);
    setDraggingId(undefined);
    if (!taskId || !from) return;
    if (from === columnId) {
      setNotice(undefined);
      return;
    }
    const row = rows.find((item) => item.task.id === taskId);
    if (!row) return;
    const decision = boardDragDecision(from, columnId, {
      reviewRequired: boardReviewRequired(row.task, row.progress),
    });
    if (decision.type === 'reject-bypass-review') {
      rejectMove(columnId);
      return;
    }
    if (decision.type !== 'allow') return;

    const label = taskBoardColumns.find((column) => column.id === columnId)?.label ?? columnId;
    // Apply placement first so the card moves; parent may persist via onMoveTask.
    setPlacements((current) => ({ ...current, [taskId]: columnId }));
    try {
      const result = await onMoveTask?.(taskId, from, columnId);
      if (result === false) {
        setPlacements((current) => {
          const next = { ...current };
          delete next[taskId];
          return next;
        });
        rejectMove(columnId);
        return;
      }
      setNotice(`已移到「${label}」。`);
    } catch {
      setPlacements((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      rejectMove(columnId);
    }
  }

  return (
    <div className="zm-task-board" aria-label="任务看板">
      {notice && (
        <p className="zm-board-drag-notice" role="status">
          {notice}
        </p>
      )}
      {taskBoardColumns.map((column) => {
        const items = rows.filter((item) => columnOf(item.task.id) === column.id);
        return (
          <section
            className={`zm-board-column${overColumn === column.id ? ' is-drop-target' : ''}`}
            key={column.id}
            aria-label={`${column.label} ${items.length} 项`}
            onDragOver={(event) => onColumnDragOver(event, column.id)}
            onDragLeave={() => {
              if (overColumn === column.id) setOverColumn(undefined);
            }}
            onDrop={(event) => {
              void onColumnDrop(event, column.id);
            }}
          >
            <h2>
              {column.label}
              <span>{items.length}</span>
            </h2>
            {items.map(({ task, progress: taskProgress }) => (
              <button
                className={`zm-board-card${draggingId === task.id ? ' is-dragging' : ''}`}
                key={task.id}
                type="button"
                draggable
                onDragStart={(event) => onCardDragStart(event, task.id)}
                onDragEnd={() => {
                  setDraggingId(undefined);
                  setOverColumn(undefined);
                }}
                onClick={() => openTask(task.id)}
              >
                <small>{projects.find((project) => project.id === task.projectId)?.name}</small>
                <strong>{task.title}</strong>
                <TaskProgressSummary
                  progress={taskProgress}
                  confirmed={confirmed(task.id)}
                  compact
                />
                <span className="zm-board-card-footer">
                  <span>
                    {participants.find((person) => person.id === task.ownerId)?.name ??
                      '负责人待定'}
                  </span>
                  <span>
                    {task.workflows.reduce((count, workflow) => count + workflow.nodes.length, 0)}{' '}
                    节点
                  </span>
                </span>
              </button>
            ))}
            {!items.length && <p className="zm-board-empty">暂无任务</p>}
          </section>
        );
      })}
    </div>
  );
}
