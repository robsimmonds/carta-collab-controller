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













