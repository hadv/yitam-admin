# GitHub Repository Setup

## Pushing to the Repository

To push this code to GitHub, follow these steps:

### Using SSH (Recommended)

1. First, make sure you have SSH keys set up and added to your GitHub account
   - [GitHub SSH Key Setup Guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)

2. Add the remote repository (if not already added):
   ```
   git remote add origin git@github.com:hadv/yitam-admin.git
   ```

3. Push to GitHub:
   ```
   git push -u origin master
   ```

### Using HTTPS

1. Add the remote repository (if not already added):
   ```
   git remote add origin https://github.com/hadv/yitam-admin.git
   ```

2. Push to GitHub (you'll be prompted for your GitHub username and password/token):
   ```
   git push -u origin master
   ```
   Note: GitHub no longer accepts passwords for HTTPS Git operations. You'll need to use a personal access token instead.
   - [Creating a personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

## Cloning the Repository

To clone this repository:

```
git clone https://github.com/hadv/yitam-admin.git
```

Or with SSH:

```
git clone git@github.com:hadv/yitam-admin.git
``` 