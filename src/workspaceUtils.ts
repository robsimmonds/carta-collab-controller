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
 * Clones a git repository from source to destination. (No worktree support here)
 */
export async function cloneGitRepo(sourceFolder: string, destinationFolder: string): Promise<void> {
    // Step 1: Clone entire repo (all branches, but no hardlinks)
    await execAsync(`git clone --no-local "${sourceFolder}" "${destinationFolder}"`);
    console.log(`Cloned full repo from ${sourceFolder} to ${destinationFolder}`);

    // Step 2: Create local branches for all remote branches except master and symbolic refs
    const { stdout } = await execAsync(`git branch -r`, { cwd: destinationFolder });
    const remoteBranches = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(branch =>
            branch.startsWith('origin/') &&
            branch !== 'origin/HEAD' &&
            branch !== 'origin/master' &&
            !branch.includes('->') // Exclude symbolic refs
        );

    for (const remoteBranch of remoteBranches) {
        const branchName = remoteBranch.replace('origin/', '');
        await execAsync(`git branch "${branchName}" "${remoteBranch}"`, { cwd: destinationFolder });
        console.log(`Created local branch ${branchName} from ${remoteBranch}`);
    }

    // Step 2: Remove any worktree metadata
    //const worktreesPath = path.join(destinationFolder, ".git", "worktrees");
    //if (await folderExists(worktreesPath)) {
    //    await fs.promises.rm(worktreesPath, { recursive: true, force: true });
    //    console.log(`Removed .worktrees from cloned workspace: ${worktreesPath}`);
    //}

    // Step 3: Checkout 'main' branch
    //await execAsync(`git -C "${destinationFolder}" checkout master`);
    //console.log(`Checked out 'master' branch in ${destinationFolder}`);
}

export async function cloneSingleBranchRepo(
    sourceFolder: string,
    destinationFolder: string,
    branchName: string,
    username?: string
): Promise<void> {
    let repoToClone = sourceFolder;

    // If branch is from a worktree, still clone from the *main repo*, not the worktree
    if (branchName !== "master" && username) {
        const worktreePath = path.join(sourceFolder, ".worktrees", username, branchName);
        if (!(await folderExists(worktreePath))) {
            throw new Error(`Worktree for branch "${branchName}" and user "${username}" does not exist.`);
        }
        // Always use the main repo path for cloning, not the worktree path
    }

    // Clone as independent repo with full branch history
    await execAsync(
        `git clone --no-local --branch "${branchName}" --single-branch "${repoToClone}" "${destinationFolder}"`
    );

    // Optional: Rename branch to master
    if (branchName !== "master") {
        await execAsync(`git branch -m "${branchName}" master`, { cwd: destinationFolder });
    }

    console.log(`Cloned branch "${branchName}" into independent repo at ${destinationFolder}`);
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
 
export async function readWorkspaceJson(folderPath: string): Promise<any> {
  const filePath = path.join(folderPath, "workspace.json");
  const jsonString = await fs.promises.readFile(filePath, "utf-8");
  return JSON.parse(jsonString);
}
*/
export async function readJsonFile(filePath: string): Promise<any> {
    const jsonString = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(jsonString);
}

export async function readWorkspaceJson(folderPath: string): Promise<any> {
    const filePath = path.join(folderPath, "workspace.json");
    return readJsonFile(filePath);
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
export async function getOrCreateBranchWorktree(
  workspaceFolder: string,
  branchName: string
): Promise<string> {
  const worktreeBase = path.join(workspaceFolder, ".worktrees");
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
  console.log(`Created worktree for branch ${branchName}: ${worktreePath}`);
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

export async function writeWorkspaceFolder(workspaceFolder: string, workspace: any): Promise<void> {
    // Write workspace metadata (excluding files and colorBlendingImages)
    const { files, colorBlendingImages, ...metadata } = workspace;
    await writeJsonFile(path.join(workspaceFolder, "workspace.json"), metadata);

    // Write files
    //const filesFolder = path.join(workspaceFolder, "files");
    //await fs.promises.mkdir(filesFolder, { recursive: true });
    
    // Write files only if there are changes
    const filesFolder = path.join(workspaceFolder, "files");
    await fs.promises.mkdir(filesFolder, { recursive: true });

    // Get existing file IDs
    const existingFileIds = (await fs.promises.readdir(filesFolder)).filter(f => !isNaN(Number(f)));

    // Track incoming file IDs
    const incomingFileIds = (files ?? []).map(f => String(f.id));

    // Remove files that are no longer in workspace.files
    for (const fileId of existingFileIds) {
        if (!incomingFileIds.includes(fileId)) {
            await fs.promises.rm(path.join(filesFolder, fileId), { recursive: true, force: true });
        }
    }
    
    // Write or update files
    for (const file of files ?? []) {
        const fileFolder = path.join(filesFolder, String(file.id));
        await fs.promises.mkdir(fileFolder, { recursive: true });
        //await writeJsonFile(path.join(fileFolder, "file.json"), file);

        // Only write file.json if changed
        await writeJsonFile(path.join(fileFolder, "file.json"), file);

        if (file.regionsSet) {
            await writeJsonFile(path.join(fileFolder, "regions.json"), file.regionsSet);
        }
        if (file.renderConfig) {
            await writeJsonFile(path.join(fileFolder, "renderConfig.json"), file.renderConfig);
        }
        if (file.contourConfig) {
            await writeJsonFile(path.join(fileFolder, "contourConfig.json"), file.contourConfig);
        }
        if (file.vectorOverlayConfig) {
            await writeJsonFile(path.join(fileFolder, "vectorOverlayConfig.json"), file.vectorOverlayConfig);
        }
    }

    // Write colorBlendingImages
    if (colorBlendingImages) {
        const blendingFolder = path.join(workspaceFolder, "colorBlendingImages");
        await fs.promises.mkdir(blendingFolder, { recursive: true });

        // Remove old blending images not present in the new workspace
        const existingBlendFiles = await fs.promises.readdir(blendingFolder);
        const incomingBlendIndices = colorBlendingImages.map(img => `${img.imageListIndex}.json`);
        for (const blendFile of existingBlendFiles) {
            if (!incomingBlendIndices.includes(blendFile)) {
                await fs.promises.rm(path.join(blendingFolder, blendFile), { force: true });
            }
        }

        for (const img of colorBlendingImages) {
            await writeJsonFile(path.join(blendingFolder, `${img.imageListIndex}.json`), img);
        }
    }
}

export async function readWorkspaceFolder(workspaceFolder: string): Promise<any> {
    const metadata = await readWorkspaceJson(workspaceFolder);

    const files: any[] = [];
    const filesFolder = path.join(workspaceFolder, "files");

    if (await folderExists(filesFolder)) {
        for (const fileId of await fs.promises.readdir(filesFolder)) {
            const fileFolder = path.join(filesFolder, fileId);

            // use readJsonFile for files
            const file = await readJsonFile(path.join(fileFolder, "file.json"));

            if (await fileExists(path.join(fileFolder, "regions.json"))) {
                file.regionsSet = await readJsonFile(path.join(fileFolder, "regions.json"));
            }
            if (await fileExists(path.join(fileFolder, "renderConfig.json"))) {
                file.renderConfig = await readJsonFile(path.join(fileFolder, "renderConfig.json"));
            }
            if (await fileExists(path.join(fileFolder, "contourConfig.json"))) {
                file.contourConfig = await readJsonFile(path.join(fileFolder, "contourConfig.json"));
            }
            if (await fileExists(path.join(fileFolder, "vectorOverlayConfig.json"))) {
                file.vectorOverlayConfig = await readJsonFile(path.join(fileFolder, "vectorOverlayConfig.json"));
            }

            files.push(file);
        }
    }
    metadata.files = files;

    // Read colorBlendingImages
    const blendingFolder = path.join(workspaceFolder, "colorBlendingImages");
    if (await folderExists(blendingFolder)) {
        metadata.colorBlendingImages = [];
        for (const imgFile of await fs.promises.readdir(blendingFolder)) {
            metadata.colorBlendingImages.push(await readJsonFile(path.join(blendingFolder, imgFile)));
        }
    }

    return metadata;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}
