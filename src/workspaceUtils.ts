import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Creates a folder if it does not exist.
 */
export async function createFolderIfNotExists(folderPath: string): Promise<void> {
  try {
    await fs.promises.access(folderPath, fs.constants.F_OK);
    console.log("Folder already exists:", folderPath);
  } catch {
    await fs.promises.mkdir(folderPath, { recursive: true });
    console.log("Folder created:", folderPath);
  }
}

/**
 * Initializes a Git repository in the given folder if not already initialized.
 */
export async function initializeGitRepository(folderPath: string): Promise<void> {
  const gitFolder = path.join(folderPath, ".git");
  try {
    await fs.promises.access(gitFolder, fs.constants.F_OK);
    console.log("Git repository already exists in:", folderPath);
  } catch {
    await execAsync("git init", { cwd: folderPath });
    console.log("Git repository initialized in:", folderPath);
  }
}

/**
 * Writes a JSON file to the specified path.
 */
export async function writeJsonFile(filePath: string, data: any): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  console.log("JSON written to:", filePath);
}

/**
 * Stages all changes and creates a Git commit with the given message.
 */
export async function stageAndCommit(folderPath: string, commitMessage: string): Promise<void> {
  await execAsync("git add .", { cwd: folderPath });
  await execAsync(`git commit -m "${commitMessage}"`, { cwd: folderPath });
  console.log("Git commit completed in:", folderPath);
}


/**
 * Rolls back workspace operations by attempting to remove the workspace folder.
 * Logs the result without throwing an error.
 */
export async function rollbackWorkspaceFolder(folderPath: string): Promise<void> {
  try {
    await fs.promises.rm(folderPath, { recursive: true, force: true });
    console.log("Workspace folder removed:", folderPath);
  } catch (rollbackErr) {
    console.error("Rollback failed:", rollbackErr);
  }
}


/**
 * Verifies that the folder exists. If it doesn't, throws an error.
 */
export async function ensureFolderExists(folderPath: string): Promise<void> {
  try {
    await fs.promises.access(folderPath, fs.constants.F_OK);
  } catch {
    throw new Error("Workspace folder not found");
  }
}

/**
 * Deletes the workspace folder (and its .git repo) recursively.
 * Logs any errors that occur, but does not throw.
 */
export async function deleteWorkspaceFolder(folderPath: string): Promise<void> {
  try {
    await fs.promises.rm(folderPath, { recursive: true, force: true });
    console.log("Workspace folder deleted successfully:", folderPath);
  } catch (error) {
    console.error("Error deleting workspace folder:", error);
  }
}

/**
 * Checks if a folder exists. Returns true if it exists, false otherwise.
 */
export async function folderExists(folderPath: string): Promise<boolean> {
  try {
    await fs.promises.access(folderPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clones a git repository from source to destination.
 */
export async function cloneGitRepo(sourceFolder: string, destinationFolder: string): Promise<void> {
  await execAsync(`git clone "${sourceFolder}" "${destinationFolder}"`);
  console.log(`Cloned git repo from ${sourceFolder} to ${destinationFolder}`);
}

/**
 * Creates a new git branch in the given folder.
 */
export async function createGitBranch(folderPath: string, branchName: string): Promise<void> {
  await execAsync(`git checkout -b "${branchName}"`, { cwd: folderPath });
  console.log(`Created branch ${branchName} in ${folderPath}`);
}

/**
 * Checks out a git branch in the given folder.
 */
export async function checkoutGitBranch(workspaceFolder: string, branchName: string) {
  await execAsync(`git checkout ${branchName}`, { cwd: workspaceFolder });
}

/**
 * Lists all git branches in the given folder.
 */
export async function listGitBranches(workspaceFolder: string): Promise<{branches: string[], current: string}> {
  const { stdout } = await execAsync(`git branch --list`, { cwd: workspaceFolder });
  let current = "";
  const branches = stdout
    .split("\n")
    .map(line => {
      if (line.startsWith("*")) {
        current = line.replace(/^\*\s*/, "");
        return current;
      }
      return line.replace(/^\s*/, "");
    })
    .filter(Boolean);
  return { branches, current };
}

/**
 * Reads and parses the workspace.json file from the given workspace folder.
 * Throws if the file cannot be read or parsed.
 */
export async function readWorkspaceJson(folderPath: string): Promise<any> {
  const filePath = path.join(folderPath, "workspace.json");
  const jsonString = await fs.promises.readFile(filePath, "utf-8");
  return JSON.parse(jsonString);
}

/**
 * Returns a list of commits with their hashes, parents, and refs (branches/tags)
 */
export async function getGitCommitGraph(folderPath: string): Promise<any[]> {
  const { stdout } = await execAsync(
    `git log --all --pretty=format:'%H|%P|%D|%s|%an|%ae|%ad|%BEND_OF_BODY' --date=iso`,
    { cwd: folderPath }
  );
  // Each line: hash|parent(s)|refs|subject|author|email|date|bodyEND_OF_BODY
  return stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, parents, refs, subject, author, email, date, ...bodyParts] = line.split('|');
      const body = (bodyParts.join('|') || '').replace(/END_OF_BODY$/, '');
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs,
        subject,
        author,
        email,
        date,
        body,
      };
    });
}

/**
 * Deletes a git branch in the given folder.
 * Throws if the branch cannot be deleted.
 */
export async function deleteGitBranch(folderPath: string, branchName: string): Promise<void> {
  // -D forces delete even if not merged; use -d for safe delete
  await execAsync(`git branch -D "${branchName}"`, { cwd: folderPath });
  console.log(`Deleted branch ${branchName} in ${folderPath}`);
}

/**
 * Creates a git worktree for a user/branch if it doesn't exist, and returns its path.
 * The worktree will be at: <workspaceFolder>/.worktrees/<username>/<branchName>
 */
export async function getOrCreateUserWorktree(
  workspaceFolder: string,
  username: string,
  branchName: string
): Promise<string> {
  const worktreeBase = path.join(workspaceFolder, ".worktrees", username);
  const worktreePath = path.join(worktreeBase, branchName);

  // If the worktree already exists, just return it
  if (await folderExists(worktreePath)) {
    return worktreePath;
  }

  // Ensure the base folder exists
  await fs.promises.mkdir(worktreeBase, { recursive: true });

  // Add the worktree
  await execAsync(
    `git worktree add "${worktreePath}" "${branchName}"`,
    { cwd: workspaceFolder }
  );
  console.log(`Created worktree for user ${username} branch ${branchName}: ${worktreePath}`);
  return worktreePath;
}

/**
 * Commits and pushes worktree changes, then deletes the worktree.
 */
export async function finalizeAndDeleteWorktree(
  workspaceFolder: string,
  worktreePath: string,
  branchName: string,
  commitMessage: string = "Sync worktree changes"
): Promise<void> {
  // Commit any changes in the worktree
  //await stageAndCommit(worktreePath, commitMessage);

  // Push changes to the branch in the main repo
  await execAsync(`git push origin ${branchName}`, { cwd: worktreePath }).catch(() => {});

  // Remove the worktree
  await execAsync(`git worktree remove "${worktreePath}"`, { cwd: workspaceFolder });
  // Optionally, delete the worktree folder if not removed
  try {
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
  } catch (err) {
    console.error("Failed to remove worktree folder:", err);
  }
}