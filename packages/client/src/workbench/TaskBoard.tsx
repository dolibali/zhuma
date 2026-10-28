import type { Participant, Project, WorkTask } from '@zhuma/agent-core';
import type { TaskProgressState } from '../execution/useTaskProgress.js';
import { TaskProgressSummary } from '../execution/TaskProgressSummary.js';
import { taskBoardColumn, taskBoardColumns } from './task-board.js';

export function TaskBoard({
  tasks,
  projects,
  participants,
  progress,
  openTask,
}: {
  tasks: readonly WorkTask[];
  projects: readonly Project[];
  participants: readonly Participant[];
  progress(taskId: string): TaskProgressState | undefined;
  openTask(taskId: string): void;
}) {
  const rows = tasks.map((task) => ({ task, progress: progress(task.id) }));
  return (
    <div className="zm-task-board" aria-label="任务看板">
      {taskBoardColumns.map((column) => {
        const items = rows.filter(
          (item) => taskBoardColumn(item.task, item.progress) === column.id,
        );
        return (
          <section
            className="zm-board-column"
            key={column.id}
            aria-label={`${column.label} ${items.length} 项`}
          >
            <h2>
              {column.label}
              <span>{items.length}</span>
            </h2>
            {items.map(({ task, progress: taskProgress }) => (
              <button className="zm-board-card" key={task.id} onClick={() => openTask(task.id)}>
                <small>{projects.find((project) => project.id === task.projectId)?.name}</small>
                <strong>{task.title}</strong>
                <TaskProgressSummary
                  progress={taskProgress}
                  confirmed={task.status === 'ready'}
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
